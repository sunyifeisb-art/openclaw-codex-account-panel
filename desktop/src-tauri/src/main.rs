use serde::{Deserialize, Serialize};
use std::{
  env,
  fs,
  fs::OpenOptions,
  net::TcpStream,
  path::PathBuf,
  process::{Command, Stdio},
  sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
  },
  thread,
  time::Duration,
};
use tauri::{
  image::Image,
  menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem},
  tray::TrayIconBuilder,
  AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
  Wry,
};
#[cfg(target_os = "macos")]
use tauri::ActivationPolicy;

const PORT: u16 = 7071;
const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_ID: &str = "codex-panel-tray";

const ID_REFRESH: &str = "refresh";
const ID_OPEN_PANEL: &str = "open_panel";
const ID_THEME_SYSTEM: &str = "theme_system";
const ID_THEME_LIGHT: &str = "theme_light";
const ID_THEME_DARK: &str = "theme_dark";
const ID_QUIT: &str = "quit_app";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PanelPreferences {
  launch_mode: String,
  theme_mode: String,
  last_menu_refresh_at: u64,
}

impl Default for PanelPreferences {
  fn default() -> Self {
    Self {
      launch_mode: "menubar-only".into(),
      theme_mode: "system".into(),
      last_menu_refresh_at: 0,
    }
  }
}

#[derive(Debug, Clone, Copy)]
struct LaunchShape {
  shows_window_on_launch: bool,
  enables_menu_bar: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct MenubarSummary {
  current_profile: Option<SummaryProfile>,
  space: Option<SummarySpace>,
  channel: Option<String>,
  usage: SummaryUsage,
  refreshed_at: Option<u64>,
  refreshed_at_text: Option<String>,
  preferences: Option<PanelPreferences>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SummaryProfile {
  id: String,
  label: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SummarySpace {
  #[allow(dead_code)]
  r#type: Option<String>,
  label: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SummaryUsage {
  five_hour: SummaryWindow,
  weekly: SummaryWindow,
  stale: bool,
  error: Option<String>,
  #[allow(dead_code)]
  source: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SummaryWindow {
  label: Option<String>,
  text: Option<String>,
}

#[derive(Clone)]
struct TrayMenuHandles {
  current_account: MenuItem<Wry>,
  current_space: MenuItem<Wry>,
  current_channel: MenuItem<Wry>,
  usage_five_hour: MenuItem<Wry>,
  usage_weekly: MenuItem<Wry>,
  refreshed_at: MenuItem<Wry>,
  refresh_now: MenuItem<Wry>,
  open_panel: MenuItem<Wry>,
  theme_system: CheckMenuItem<Wry>,
  theme_light: CheckMenuItem<Wry>,
  theme_dark: CheckMenuItem<Wry>,
}

struct DesktopState {
  preferences_path: PathBuf,
  tray_menu: Mutex<Option<TrayMenuHandles>>,
  allow_exit: AtomicBool,
}

impl DesktopState {
  fn new(preferences_path: PathBuf) -> Self {
    Self {
      preferences_path,
      tray_menu: Mutex::new(None),
      allow_exit: AtomicBool::new(false),
    }
  }
}

fn resolve_workspace_root() -> Result<PathBuf, String> {
  if let Ok(value) = env::var("OPENCLAW_WORKSPACE") {
    let trimmed = value.trim();
    if !trimmed.is_empty() {
      return Ok(PathBuf::from(trimmed));
    }
  }
  let home = env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
  Ok(PathBuf::from(home).join(".openclaw").join("workspace"))
}

fn panel_preferences_path() -> Result<PathBuf, String> {
  Ok(resolve_workspace_root()?.join("data").join("codex-panel-preferences.json"))
}

fn panel_server_pid_path() -> Result<PathBuf, String> {
  Ok(resolve_workspace_root()?.join("codex-account-panel").join("data").join("codex-account-panel.pid"))
}

fn is_port_open() -> bool {
  TcpStream::connect(("127.0.0.1", PORT)).is_ok()
}

fn pid_is_running(pid: u32) -> bool {
  Command::new("kill")
    .arg("-0")
    .arg(pid.to_string())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .status()
    .map(|s| s.success())
    .unwrap_or(false)
}

fn auth_store_path() -> Result<PathBuf, String> {
  let home = env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
  Ok(
    PathBuf::from(home)
      .join(".openclaw")
      .join("agents")
      .join("main")
      .join("agent")
      .join("auth-profiles.json"),
  )
}

fn has_node_runtime() -> bool {
  Command::new("node")
    .arg("--version")
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .status()
    .map(|s| s.success())
    .unwrap_or(false)
}

fn has_openclaw_cli() -> bool {
  Command::new("openclaw")
    .arg("--version")
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .status()
    .map(|s| s.success())
    .unwrap_or(false)
}

fn resource_paths() -> Option<(PathBuf, PathBuf)> {
  let exe = env::current_exe().ok()?;
  let resource_dir = exe.parent()?.parent()?.join("Resources");
  let server_path = resource_dir.join("panel").join("server.mjs");
  let login_script = resource_dir.join("scripts").join("openclaw_codex_add_profile.mjs");
  if server_path.exists() && login_script.exists() {
    Some((server_path, login_script))
  } else {
    None
  }
}

fn is_panel_server_compatible() -> bool {
  let preferences_ok = ureq::get(&format!("http://127.0.0.1:{PORT}/api/preferences"))
    .call()
    .ok()
    .map(|response| response.status() == 200)
    .unwrap_or(false);
  let menubar_ok = ureq::get(&format!("http://127.0.0.1:{PORT}/api/menubar-summary"))
    .call()
    .ok()
    .map(|response| response.status() == 200)
    .unwrap_or(false);
  preferences_ok && menubar_ok
}

fn stop_stale_panel_server(pid_path: &PathBuf) {
  if let Ok(pid_raw) = fs::read_to_string(pid_path) {
    if let Ok(pid) = pid_raw.trim().parse::<u32>() {
      let _ = Command::new("kill").arg(pid.to_string()).status();
      for _ in 0..20 {
        if !is_port_open() {
          break;
        }
        thread::sleep(Duration::from_millis(250));
      }
    }
  }
}

fn stop_panel_server_on_exit() {
  if let Ok(pid_path) = panel_server_pid_path() {
    stop_stale_panel_server(&pid_path);
    let _ = fs::remove_file(pid_path);
  }
}

fn ensure_server_running() -> Result<(), String> {
  if !has_node_runtime() {
    return Err("未检测到 node 运行时。这个桌面版面向已经在本机使用 OpenClaw 的用户；请先确认本机能正常运行 OpenClaw。".into());
  }
  if !has_openclaw_cli() {
    return Err("未检测到 openclaw 命令。请先在这台 Mac 上安装并配置 OpenClaw。".into());
  }
  let auth_path = auth_store_path()?;
  if !auth_path.exists() {
    return Err(format!(
      "未找到 OpenClaw 账号数据：{}。请先在本机用 OpenClaw 登录至少一个 Codex 账号。",
      auth_path.display()
    ));
  }

  let workspace_root = resolve_workspace_root()?;
  let panel_home = workspace_root.join("codex-account-panel");
  let log_path = panel_home.join("output").join("codex-account-panel.log");
  let pid_path = panel_home.join("data").join("codex-account-panel.pid");
  let (server_path, login_script_path) = resource_paths().unwrap_or((
    workspace_root.join("apps").join("codex-account-panel").join("server.mjs"),
    workspace_root.join("scripts").join("openclaw_codex_add_profile.mjs"),
  ));

  if is_port_open() {
    if is_panel_server_compatible() {
      return Ok(());
    }
    stop_stale_panel_server(&pid_path);
  }

  if let Ok(pid_raw) = fs::read_to_string(&pid_path) {
    if let Ok(pid) = pid_raw.trim().parse::<u32>() {
      if pid_is_running(pid) {
        for _ in 0..20 {
          if is_port_open() && is_panel_server_compatible() {
            return Ok(());
          }
          thread::sleep(Duration::from_millis(250));
        }
      }
    }
  }

  fs::create_dir_all(panel_home.join("output")).map_err(|e| e.to_string())?;
  fs::create_dir_all(panel_home.join("data")).map_err(|e| e.to_string())?;

  let stdout = OpenOptions::new()
    .create(true)
    .append(true)
    .open(&log_path)
    .map_err(|e| format!("open log failed: {e}"))?;
  let stderr = OpenOptions::new()
    .create(true)
    .append(true)
    .open(&log_path)
    .map_err(|e| format!("open log failed: {e}"))?;

  let child = Command::new("node")
    .arg(&server_path)
    .current_dir(&workspace_root)
    .env("OPENCLAW_WORKSPACE", &workspace_root)
    .env("OPENCLAW_CODEX_PANEL_HOME", &panel_home)
    .env("OPENCLAW_CODEX_LOGIN_SCRIPT", &login_script_path)
    .stdout(Stdio::from(stdout))
    .stderr(Stdio::from(stderr))
    .spawn()
    .map_err(|e| format!("start server failed: {e}"))?;

  fs::write(&pid_path, child.id().to_string()).map_err(|e| format!("write pid failed: {e}"))?;

  for _ in 0..40 {
    if is_port_open() && is_panel_server_compatible() {
      return Ok(());
    }
    thread::sleep(Duration::from_millis(250));
  }

  Err("panel server did not become ready in time".into())
}

fn normalize_launch_mode(value: &str) -> String {
  match value {
    "window-only" | "menubar-only" | "window-and-menubar" => value.to_string(),
    _ => "menubar-only".into(),
  }
}

fn normalize_theme_mode(value: &str) -> String {
  match value {
    "system" | "light" | "dark" => value.to_string(),
    _ => "system".into(),
  }
}

fn derive_launch_shape(_launch_mode: &str) -> LaunchShape {
  LaunchShape {
    shows_window_on_launch: true,
    enables_menu_bar: true,
  }
}

fn read_panel_preferences_from_path(path: &PathBuf) -> PanelPreferences {
  let raw = fs::read_to_string(path)
    .ok()
    .and_then(|content| serde_json::from_str::<PanelPreferences>(&content).ok())
    .unwrap_or_default();
  PanelPreferences {
    launch_mode: "menubar-only".into(),
    theme_mode: normalize_theme_mode(&raw.theme_mode),
    last_menu_refresh_at: raw.last_menu_refresh_at,
  }
}

fn read_panel_preferences(app: &AppHandle<Wry>) -> PanelPreferences {
  let state = app.state::<DesktopState>();
  read_panel_preferences_from_path(&state.preferences_path)
}

fn write_panel_preferences(app: &AppHandle<Wry>, next: &PanelPreferences) -> Result<PanelPreferences, String> {
  let state = app.state::<DesktopState>();
  if let Some(parent) = state.preferences_path.parent() {
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }
  let normalized = PanelPreferences {
    launch_mode: "menubar-only".into(),
    theme_mode: normalize_theme_mode(&next.theme_mode),
    last_menu_refresh_at: next.last_menu_refresh_at,
  };
  let payload = serde_json::to_string_pretty(&normalized).map_err(|e| e.to_string())? + "\n";
  fs::write(&state.preferences_path, payload).map_err(|e| e.to_string())?;
  Ok(normalized)
}

fn panel_url() -> Result<WebviewUrl, tauri::Error> {
  let startup_ok = ensure_server_running().is_ok();
  if startup_ok {
    Ok(WebviewUrl::External(external_panel_url()?))
  } else {
    Ok(WebviewUrl::App("index.html".into()))
  }
}

fn external_panel_url() -> Result<Url, tauri::Error> {
  format!("http://127.0.0.1:{PORT}")
    .parse::<Url>()
    .map_err(|e| tauri::Error::Io(std::io::Error::other(e.to_string())))
}

fn create_main_window(app: &AppHandle<Wry>) -> tauri::Result<WebviewWindow<Wry>> {
  WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, panel_url()?)
    .title("OpenClaw Panel")
    .inner_size(1320.0, 920.0)
    .min_inner_size(980.0, 720.0)
    .resizable(true)
    .build()
}

fn open_or_show_main_window(app: &AppHandle<Wry>) -> tauri::Result<()> {
  #[cfg(target_os = "macos")]
  {
    let _ = app.set_activation_policy(ActivationPolicy::Regular);
    let _ = app.set_dock_visibility(true);
  }
  let window = if let Some(existing) = app.get_webview_window(MAIN_WINDOW_LABEL) {
    existing
  } else {
    create_main_window(app)?
  };
  let _ = window.show();
  let _ = window.unminimize();
  let _ = window.set_focus();
  Ok(())
}

fn hide_main_window(app: &AppHandle<Wry>) {
  if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
    let _ = window.hide();
  }
  #[cfg(target_os = "macos")]
  {
    let _ = app.set_dock_visibility(false);
    let _ = app.set_activation_policy(ActivationPolicy::Accessory);
  }
}

fn build_tray_menu(app: &AppHandle<Wry>, prefs: &PanelPreferences) -> tauri::Result<(Menu<Wry>, TrayMenuHandles)> {
  let current_account = MenuItem::with_id(app, "summary_account", "当前账号：加载中...", true, None::<&str>)?;
  let current_space = MenuItem::with_id(app, "summary_space", "当前空间：加载中...", true, None::<&str>)?;
  let current_channel = MenuItem::with_id(app, "summary_channel", "当前渠道：加载中...", true, None::<&str>)?;
  let usage_five_hour = MenuItem::with_id(app, "summary_5h", "5h：加载中...", true, None::<&str>)?;
  let usage_weekly = MenuItem::with_id(app, "summary_week", "1周：加载中...", true, None::<&str>)?;
  let refreshed_at = MenuItem::with_id(app, "summary_refreshed", "最近刷新：--", true, None::<&str>)?;

  let refresh_now = MenuItem::with_id(app, ID_REFRESH, "立即刷新", true, None::<&str>)?;
  let open_panel = MenuItem::with_id(app, ID_OPEN_PANEL, "打开完整面板", true, None::<&str>)?;

  let theme_system = CheckMenuItem::with_id(app, ID_THEME_SYSTEM, "主题：跟随系统", true, prefs.theme_mode == "system", None::<&str>)?;
  let theme_light = CheckMenuItem::with_id(app, ID_THEME_LIGHT, "主题：浅色模式", true, prefs.theme_mode == "light", None::<&str>)?;
  let theme_dark = CheckMenuItem::with_id(app, ID_THEME_DARK, "主题：深色模式", true, prefs.theme_mode == "dark", None::<&str>)?;

  let quit = MenuItem::with_id(app, ID_QUIT, "退出 App", true, None::<&str>)?;

  let sep1 = PredefinedMenuItem::separator(app)?;
  let sep2 = PredefinedMenuItem::separator(app)?;
  let sep3 = PredefinedMenuItem::separator(app)?;

  let menu = Menu::new(app)?;
  menu.append(&current_account)?;
  menu.append(&current_space)?;
  menu.append(&current_channel)?;
  menu.append(&usage_five_hour)?;
  menu.append(&usage_weekly)?;
  menu.append(&refreshed_at)?;
  menu.append(&sep1)?;
  menu.append(&refresh_now)?;
  menu.append(&open_panel)?;
  menu.append(&sep2)?;
  menu.append(&theme_system)?;
  menu.append(&theme_light)?;
  menu.append(&theme_dark)?;
  menu.append(&sep3)?;
  menu.append(&quit)?;

  Ok((
    menu,
    TrayMenuHandles {
      current_account,
      current_space,
      current_channel,
      usage_five_hour,
      usage_weekly,
      refreshed_at,
      refresh_now,
      open_panel,
      theme_system,
      theme_light,
      theme_dark,
    },
  ))
}

fn update_tray_checks(handles: &TrayMenuHandles, prefs: &PanelPreferences) {
  let _ = handles.theme_system.set_checked(prefs.theme_mode == "system");
  let _ = handles.theme_light.set_checked(prefs.theme_mode == "light");
  let _ = handles.theme_dark.set_checked(prefs.theme_mode == "dark");
}

fn ensure_tray(app: &AppHandle<Wry>) -> tauri::Result<()> {
  if app.tray_by_id(TRAY_ID).is_some() {
    return Ok(());
  }
  let prefs = read_panel_preferences(app);
  let (menu, handles) = build_tray_menu(app, &prefs)?;
  let mut builder = TrayIconBuilder::with_id(TRAY_ID)
    .menu(&menu)
    .show_menu_on_left_click(true)
    .tooltip("OpenClaw Panel")
    .icon_as_template(true);
  if let Ok(icon) = Image::from_bytes(include_bytes!("../icons/tray-template.png")) {
    builder = builder.icon(icon);
  } else if let Some(icon) = app.default_window_icon().cloned() {
    builder = builder.icon(icon);
  }
  builder.build(app)?;
  let state = app.state::<DesktopState>();
  *state.tray_menu.lock().unwrap() = Some(handles.clone());
  update_tray_checks(&handles, &prefs);
  Ok(())
}

fn remove_tray(app: &AppHandle<Wry>) {
  let state = app.state::<DesktopState>();
  *state.tray_menu.lock().unwrap() = None;
  let _ = app.remove_tray_by_id(TRAY_ID);
}

fn fetch_menubar_summary() -> Result<MenubarSummary, String> {
  let response = ureq::get(&format!("http://127.0.0.1:{PORT}/api/menubar-summary"))
    .call()
    .map_err(|e| e.to_string())?;
  response.into_json::<MenubarSummary>().map_err(|e| e.to_string())
}

fn refresh_tray_summary(app: &AppHandle<Wry>) {
  let handles = {
    let state = app.state::<DesktopState>();
    let handles = state.tray_menu.lock().unwrap().clone();
    handles
  };
  let Some(handles) = handles else {
    return;
  };

  let _ = handles.refresh_now.set_enabled(false);
  let _ = handles.refresh_now.set_text("立即刷新（更新中…）");
  match fetch_menubar_summary() {
    Ok(summary) => {
      let account_text = summary
        .current_profile
        .as_ref()
        .map(|profile| format!("当前账号：{}", profile.label))
        .unwrap_or_else(|| "当前账号：暂无可用账号".into());
      let space_text = summary
        .space
        .as_ref()
        .map(|space| format!("当前空间：{}", space.label))
        .unwrap_or_else(|| "当前空间：--".into());
      let channel_text = format!(
        "当前渠道：{}",
        summary.channel.clone().unwrap_or_else(|| "--".into())
      );
      let five_hour_text = format!(
        "{}：{}",
        summary
          .usage
          .five_hour
          .label
          .clone()
          .unwrap_or_else(|| "5h".into()),
        summary
          .usage
          .five_hour
          .text
          .clone()
          .unwrap_or_else(|| "暂时不可用".into())
      );
      let weekly_text = format!(
        "{}：{}",
        summary
          .usage
          .weekly
          .label
          .clone()
          .unwrap_or_else(|| "1周".into()),
        summary
          .usage
          .weekly
          .text
          .clone()
          .unwrap_or_else(|| "暂时不可用".into())
      );
      let refreshed_text = if let Some(text) = summary.refreshed_at_text.clone() {
        if summary.usage.stale {
          format!("最近刷新：{}（缓存）", text)
        } else {
          format!("最近刷新：{}", text)
        }
      } else if let Some(error) = summary.usage.error.clone() {
        format!("最近刷新：失败（{}）", error)
      } else {
        "最近刷新：--".into()
      };

      let _ = handles.current_account.set_text(account_text);
      let _ = handles.current_space.set_text(space_text);
      let _ = handles.current_channel.set_text(channel_text);
      let _ = handles.usage_five_hour.set_text(five_hour_text);
      let _ = handles.usage_weekly.set_text(weekly_text);
      let _ = handles.refreshed_at.set_text(refreshed_text);
      let _ = handles.open_panel.set_enabled(true);

      if let Some(mut prefs) = summary.preferences.clone() {
        if let Some(refreshed_at) = summary.refreshed_at {
          prefs.last_menu_refresh_at = refreshed_at;
          let _ = write_panel_preferences(app, &prefs);
        }
        update_tray_checks(&handles, &prefs);
      }
    }
    Err(error) => {
      let _ = handles.current_account.set_text("当前账号：服务未连接");
      let _ = handles.current_space.set_text("当前空间：--");
      let _ = handles.current_channel.set_text("当前渠道：--");
      let _ = handles.usage_five_hour.set_text("5h：暂时不可用");
      let _ = handles.usage_weekly.set_text("1周：暂时不可用");
      let _ = handles
        .refreshed_at
        .set_text(format!("最近刷新：失败（{}）", error));
    }
  }
  let _ = handles.refresh_now.set_enabled(true);
  let _ = handles.refresh_now.set_text("立即刷新");
}

fn spawn_tray_refresher(app: AppHandle<Wry>) {
  thread::spawn(move || {
    refresh_tray_summary(&app);
    loop {
      thread::sleep(Duration::from_secs(600));
      refresh_tray_summary(&app);
    }
  });
}

fn spawn_panel_ready_redirect(app: AppHandle<Wry>) {
  thread::spawn(move || {
    for _ in 0..60 {
      thread::sleep(Duration::from_secs(1));
      if !(is_port_open() && is_panel_server_compatible()) {
        continue;
      }
      let Ok(url) = external_panel_url() else {
        break;
      };
      if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.navigate(url);
        let _ = window.show();
      }
      break;
    }
  });
}

fn apply_theme_mode(app: &AppHandle<Wry>, theme_mode: &str) -> Result<(), String> {
  let mut prefs = read_panel_preferences(app);
  prefs.theme_mode = normalize_theme_mode(theme_mode);
  let prefs = write_panel_preferences(app, &prefs)?;
  if let Some(handles) = app.state::<DesktopState>().tray_menu.lock().unwrap().clone() {
    update_tray_checks(&handles, &prefs);
  }
  if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
    let script = format!(
      "if (window.applyTheme) {{ window.applyTheme({:?}); }} else {{ window.location.reload(); }}",
      prefs.theme_mode
    );
    let _ = window.eval(&script);
  }
  Ok(())
}

fn handle_menu_event(app: &AppHandle<Wry>, event: MenuEvent) {
  let id = event.id().0.as_str();
  match id {
    ID_REFRESH => {
      let app = app.clone();
      thread::spawn(move || refresh_tray_summary(&app));
    }
    ID_OPEN_PANEL => {
      let _ = open_or_show_main_window(app);
    }
    ID_THEME_SYSTEM => {
      let _ = apply_theme_mode(app, "system");
    }
    ID_THEME_LIGHT => {
      let _ = apply_theme_mode(app, "light");
    }
    ID_THEME_DARK => {
      let _ = apply_theme_mode(app, "dark");
    }
    ID_QUIT => {
      let state = app.state::<DesktopState>();
      state.allow_exit.store(true, Ordering::Relaxed);
      stop_panel_server_on_exit();
      app.exit(0);
    }
    _ => {}
  }
}

fn main() {
  tauri::Builder::default()
    .on_menu_event(handle_menu_event)
    .on_window_event(|window, event| {
      if window.label() != MAIN_WINDOW_LABEL {
        return;
      }
      if let WindowEvent::CloseRequested { api, .. } = event {
        let app = window.app_handle();
        let state = app.state::<DesktopState>();
        if state.allow_exit.load(Ordering::Relaxed) {
          return;
        }
        api.prevent_close();
        hide_main_window(&app);
      }
    })
    .setup(|app| {
      let preferences_path = panel_preferences_path()
        .map_err(|e| tauri::Error::Io(std::io::Error::other(e)))?;
      app.manage(DesktopState::new(preferences_path));

      let _ = ensure_server_running();

      #[cfg(target_os = "macos")]
      {
        let _ = app.handle().set_activation_policy(ActivationPolicy::Accessory);
        let _ = app.handle().set_dock_visibility(false);
      }

      let prefs = read_panel_preferences(&app.handle());
      let shape = derive_launch_shape(&prefs.launch_mode);

      if shape.enables_menu_bar {
        ensure_tray(&app.handle())?;
        spawn_tray_refresher(app.handle().clone());
      }
      if shape.shows_window_on_launch {
        open_or_show_main_window(&app.handle())?;
        spawn_panel_ready_redirect(app.handle().clone());
      }

      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building Codex account panel desktop app")
    .run(|app, event| {
      if let RunEvent::ExitRequested { api, .. } = event {
        let state = app.state::<DesktopState>();
        state.allow_exit.store(true, Ordering::Relaxed);
        stop_panel_server_on_exit();
        let _ = app.cleanup_before_exit();
        let _ = api;
      }
    });
}
