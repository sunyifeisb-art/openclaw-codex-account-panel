use std::{
  env,
  fs,
  fs::OpenOptions,
  net::TcpStream,
  path::PathBuf,
  process::{Command, Stdio},
  thread,
  time::Duration,
};
use tauri::{WebviewUrl, WebviewWindowBuilder};

const PORT: u16 = 7071;

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

fn ensure_server_running() -> Result<(), String> {
  if is_port_open() {
    return Ok(());
  }

  let workspace_root = resolve_workspace_root()?;
  let panel_home = workspace_root.join("codex-account-panel");
  let log_path = panel_home.join("output").join("codex-account-panel.log");
  let pid_path = panel_home.join("data").join("codex-account-panel.pid");
  let (server_path, login_script_path) = resource_paths()
    .unwrap_or((
      workspace_root.join("apps").join("codex-account-panel").join("server.mjs"),
      workspace_root.join("scripts").join("openclaw_codex_add_profile.mjs"),
    ));

  if let Ok(pid_raw) = fs::read_to_string(&pid_path) {
    if let Ok(pid) = pid_raw.trim().parse::<u32>() {
      if pid_is_running(pid) {
        for _ in 0..20 {
          if is_port_open() {
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
    if is_port_open() {
      return Ok(());
    }
    thread::sleep(Duration::from_millis(250));
  }

  Err("panel server did not become ready in time".into())
}

fn main() {
  tauri::Builder::default()
    .setup(|app| {
      ensure_server_running().map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;

      let url = WebviewUrl::External(format!("http://127.0.0.1:{PORT}").parse()?) ;
      let _window = WebviewWindowBuilder::new(app, "main", url)
        .title("OpenClaw Codex Panel")
        .inner_size(1320.0, 920.0)
        .min_inner_size(980.0, 720.0)
        .resizable(true)
        .build()?;

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running Codex account panel desktop app");
}
