//! Feroxes desktop shell.
//!
//! The window is a thin, native host around the Feroxes Core (a local Node service). On launch the
//! shell either **attaches** to an already-running Core (the 24/7 background brain) or **starts**
//! one as a child process, learns its URL + app token from a one-line stdout handshake, and injects
//! them into the web UI as `window.__FEROXES__`. The UI then talks to the Core over HTTP on
//! 127.0.0.1. No secrets are compiled in; nothing is exposed off the loopback interface.

use std::io::{BufRead, BufReader};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde::Deserialize;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

/// The Core child process, kept only when *this* app started it, so it is stopped on exit. When the
/// app attached to a background Core instead, this stays `None` and that Core keeps running 24/7.
struct CoreChild(Mutex<Option<Child>>);

#[derive(Deserialize)]
struct Handshake {
    url: String,
    token: String,
    #[serde(default)]
    port: u16,
}

#[derive(Clone)]
struct Connection {
    url: String,
    token: String,
}

const NODE_EXE: &str = if cfg!(windows) { "node.exe" } else { "node" };

pub fn run() {
    tauri::Builder::default()
        .manage(CoreChild(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();
            match attach_to_running().or_else(|| spawn_core(&handle).map_err(log_core_error).ok()) {
                Some(conn) => build_main_window(&handle, &conn)?,
                None => build_main_window_with_error(
                    &handle,
                    "Feroxes could not reach or start its Core service.",
                )?,
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Feroxes app")
        .run(|app, event| {
            // Stop the Core we started when the app quits (a background Core is left running).
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<CoreChild>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(mut child) = guard.take() {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }
                }
            }
        });
}

fn log_core_error(e: String) -> String {
    eprintln!("[feroxes] {e}");
    e
}

/// Per-user config dir shared with the Core (`dirs::config_dir()/feroxes`): %APPDATA%\feroxes on
/// Windows, ~/Library/Application Support/feroxes on macOS, $XDG_CONFIG_HOME|~/.config/feroxes on
/// Linux. Matches `feroxesConfigDir()` in apps/core/src/cli.ts so both sides meet at the same path.
fn feroxes_config_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("feroxes"))
}

/// If a Core wrote a runtime handshake and something is still listening on its port, reuse it.
fn attach_to_running() -> Option<Connection> {
    let file = feroxes_config_dir()?.join("runtime.json");
    let text = std::fs::read_to_string(&file).ok()?;
    let h: Handshake = serde_json::from_str(&text).ok()?;
    let port = if h.port != 0 { h.port } else { port_from_url(&h.url)? };
    if is_listening(port) {
        eprintln!("[feroxes] attaching to the Core already running at {}", h.url);
        Some(Connection { url: h.url, token: h.token })
    } else {
        None
    }
}

fn is_listening(port: u16) -> bool {
    match format!("127.0.0.1:{port}").to_socket_addrs() {
        Ok(addrs) => addrs
            .into_iter()
            .any(|a| TcpStream::connect_timeout(&a, Duration::from_millis(400)).is_ok()),
        Err(_) => false,
    }
}

fn port_from_url(url: &str) -> Option<u16> {
    url.rsplit(':').next()?.trim_end_matches('/').parse().ok()
}

/// Start the bundled Core as a child and read its `FEROXES_READY {json}` handshake from stdout.
fn spawn_core(app: &tauri::AppHandle) -> Result<Connection, String> {
    let node = resolve_node(app);
    let entry = resolve_core_entry(app)
        .ok_or_else(|| "bundled Core script not found in app resources".to_string())?;

    let mut args: Vec<String> = Vec::new();
    // Optional .env (API keys etc.) the owner can drop next to the shared config dir.
    if let Some(env_file) = feroxes_config_dir().map(|d| d.join(".env")).filter(|p| p.exists()) {
        args.push(format!("--env-file={}", env_file.display()));
    }
    args.push(entry.to_string_lossy().into_owned());
    args.push("serve".to_string());

    let mut cmd = Command::new(&node);
    cmd.args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("FEROXES_DESKTOP", "1");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not run Node at {}: {e}", node.display()))?;

    let stdout = child.stdout.take().ok_or("Core produced no stdout")?;
    let stderr = child.stderr.take().ok_or("Core produced no stderr")?;

    // Forward the Core's logs (stderr) to ours.
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("[core] {line}");
        }
    });

    // Read stdout until the handshake, then keep draining so the pipe never blocks the Core.
    let (tx, rx) = mpsc::channel::<Result<Connection, String>>();
    thread::spawn(move || {
        let mut tx = Some(tx);
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(rest) = line.strip_prefix("FEROXES_READY ") {
                if let Some(tx) = tx.take() {
                    let msg = match serde_json::from_str::<Handshake>(rest) {
                        Ok(h) => Ok(Connection { url: h.url, token: h.token }),
                        Err(e) => Err(format!("could not parse the Core handshake: {e}")),
                    };
                    let _ = tx.send(msg);
                }
            } else {
                eprintln!("[core] {line}");
            }
        }
        if let Some(tx) = tx.take() {
            let _ = tx.send(Err("the Core exited before it was ready".to_string()));
        }
    });

    // Keep the child so we can stop it on exit.
    if let Some(state) = app.try_state::<CoreChild>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = Some(child);
        }
    }

    match rx.recv_timeout(Duration::from_secs(45)) {
        Ok(Ok(conn)) => {
            eprintln!("[feroxes] Core started at {}", conn.url);
            Ok(conn)
        }
        Ok(Err(e)) => Err(e),
        Err(_) => Err("timed out waiting for the Core to start".to_string()),
    }
}

/// The Node runtime: bundled with the app if present, otherwise `node` from PATH (dev machines).
fn resolve_node(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(res) = app.path().resource_dir() {
        for cand in [
            res.join("runtime").join(NODE_EXE),
            res.join("resources").join("runtime").join(NODE_EXE),
        ] {
            if cand.exists() {
                return cand;
            }
        }
    }
    PathBuf::from(NODE_EXE)
}

/// The Core entry script inside the bundled resources (a few candidate layouts, to be robust).
fn resolve_core_entry(app: &tauri::AppHandle) -> Option<PathBuf> {
    let res = app.path().resource_dir().ok()?;
    [
        Path::new("core").join("src").join("cli.js"),
        Path::new("resources").join("core").join("src").join("cli.js"),
    ]
    .into_iter()
    .map(|rel| res.join(rel))
    .find(|p| p.exists())
}

fn build_main_window(app: &tauri::AppHandle, conn: &Connection) -> tauri::Result<()> {
    let init = format!(
        "window.__FEROXES__ = {{ url: {}, token: {} }};",
        serde_json::to_string(&conn.url).unwrap_or_else(|_| "\"\"".into()),
        serde_json::to_string(&conn.token).unwrap_or_else(|_| "\"\"".into()),
    );
    make_window(app, &init)
}

fn build_main_window_with_error(app: &tauri::AppHandle, message: &str) -> tauri::Result<()> {
    let init = format!(
        "window.__FEROXES__ = {{ error: {} }};",
        serde_json::to_string(message).unwrap_or_else(|_| "\"\"".into()),
    );
    make_window(app, &init)
}

fn make_window(app: &tauri::AppHandle, init_script: &str) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Feroxes")
        .inner_size(1280.0, 820.0)
        .min_inner_size(900.0, 600.0)
        .center()
        .initialization_script(init_script)
        .build()?;
    Ok(())
}
