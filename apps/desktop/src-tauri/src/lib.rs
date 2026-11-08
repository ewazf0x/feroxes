//! Feroxes desktop shell.
//!
//! The window is a thin, native host around the Feroxes Core (a local Node service). On launch the
//! shell either **attaches** to an already-running Core (the 24/7 background brain) or **starts**
//! one as a child process and learns its URL + app token from a one-line stdout handshake. The
//! window then loads the UI from the Core's own URL (http://127.0.0.1:<port>), so the page and the
//! API share one origin: no CORS, and no Local Network Access block or prompt in WebView2/WebKit.
//! The token is injected as `window.__FEROXES__` before the page runs. No secrets are compiled in;
//! nothing listens beyond the loopback interface.

use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

/// A Core this app started. Its stdin is a pipe the Core watches: dropping our end (or this app
/// dying) tells it to shut down cleanly. When the app attached to a background Core instead, there
/// is no `Spawned` and that Core keeps running 24/7.
struct Spawned {
    child: Child,
    stdin: Option<ChildStdin>,
}

struct CoreChild(Mutex<Option<Spawned>>);

#[derive(Deserialize)]
struct Handshake {
    url: String,
    token: String,
    #[serde(default)]
    port: u16,
}

struct Connection {
    url: String,
    token: String,
    port: u16,
}

const NODE_EXE: &str = if cfg!(windows) { "node.exe" } else { "node" };

pub fn run() {
    tauri::Builder::default()
        .manage(CoreChild(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();
            match attach_to_running().or_else(|| spawn_core(&handle).map_err(log_core_error).ok()) {
                Some(conn) => build_main_window(&handle, &conn)?,
                None => build_error_window(&handle, "Feroxes could not reach or start its Core service.")?,
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Feroxes app")
        .run(|app, event| {
            // Stop the Core we started when the app quits (a background Core is left running).
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<CoreChild>() {
                    let spawned = state.0.lock().ok().and_then(|mut guard| guard.take());
                    if let Some(spawned) = spawned {
                        stop_core(spawned);
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

/// Reuse a running Core if its handshake file exists and it accepts the token in it, so the app
/// never attaches to an unrelated process that happens to hold the port.
fn attach_to_running() -> Option<Connection> {
    let text = std::fs::read_to_string(feroxes_config_dir()?.join("runtime.json")).ok()?;
    let h: Handshake = serde_json::from_str(&text).ok()?;
    let port = if h.port != 0 { h.port } else { port_from_url(&h.url)? };
    if local_get(port, "/api/status", Some(&h.token)) == Some(200) {
        eprintln!("[feroxes] attaching to the Core already running at {}", h.url);
        Some(Connection { url: h.url, token: h.token, port })
    } else {
        None
    }
}

/// Minimal HTTP/1.1 GET to the local Core (std only). Returns the response status code.
fn local_get(port: u16, path: &str, token: Option<&str>) -> Option<u16> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(600)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(3))).ok()?;
    stream.set_write_timeout(Some(Duration::from_secs(3))).ok()?;
    let auth = token.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
    let request = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{auth}Connection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).ok()?;
    let mut status_line = String::new();
    BufReader::new(stream).read_line(&mut status_line).ok()?;
    status_line.split_whitespace().nth(1)?.parse().ok()
}

fn port_from_url(url: &str) -> Option<u16> {
    url.trim_end_matches('/').rsplit(':').next()?.parse().ok()
}

/// Start the bundled Core as a child and read its `FEROXES_READY {json}` handshake from stdout.
fn spawn_core(app: &tauri::AppHandle) -> Result<Connection, String> {
    let node = resolve_node(app);
    let entry = resolve_core_entry(app).ok_or_else(|| "bundled Core script not found in app resources".to_string())?;

    let mut args: Vec<String> = Vec::new();
    // Optional .env (API keys etc.) the owner can drop in the shared config dir.
    if let Some(env_file) = feroxes_config_dir().map(|d| d.join(".env")).filter(|p| p.exists()) {
        args.push(format!("--env-file={}", env_file.display()));
    }
    args.push(entry.to_string_lossy().into_owned());
    args.push("serve".to_string());

    let mut cmd = Command::new(&node);
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("FEROXES_DESKTOP", "1")
        .env("FEROXES_PARENT_PIPE", "1")
        // Start this PC's device agent with the Core and pair it automatically.
        .env("FEROXES_LOCAL_AGENT", "1")
        .env("NODE_NO_WARNINGS", "1");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| format!("could not run Node at {}: {e}", node.display()))?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().ok_or("the Core produced no stdout")?;
    let stderr = child.stderr.take().ok_or("the Core produced no stderr")?;

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
            match (line.strip_prefix("FEROXES_READY "), tx.take()) {
                (Some(rest), Some(sender)) => {
                    let msg = serde_json::from_str::<Handshake>(rest)
                        .map_err(|e| format!("could not parse the Core handshake: {e}"))
                        .and_then(|h| {
                            let port = if h.port != 0 { h.port } else { port_from_url(&h.url).ok_or("the Core handshake has no port")? };
                            Ok(Connection { url: h.url, token: h.token, port })
                        });
                    let _ = sender.send(msg);
                }
                (_, sender) => {
                    tx = sender;
                    eprintln!("[core] {line}");
                }
            }
        }
        if let Some(sender) = tx.take() {
            let _ = sender.send(Err("the Core exited before it was ready".to_string()));
        }
    });

    // Keep the child so we can stop it on exit, even if the handshake fails below.
    if let Some(state) = app.try_state::<CoreChild>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = Some(Spawned { child, stdin });
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

/// Ask a Core we started to shut down cleanly (close its stdin), then force it after a grace period.
fn stop_core(mut spawned: Spawned) {
    drop(spawned.stdin.take());
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        match spawned.child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(_) => break,
        }
    }
    let _ = spawned.child.kill();
    let _ = spawned.child.wait();
}

/// The Node runtime: bundled with the app if present, otherwise `node` from PATH (dev machines).
fn resolve_node(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(res) = app.path().resource_dir() {
        for candidate in [res.join("runtime").join(NODE_EXE), res.join("resources").join("runtime").join(NODE_EXE)] {
            if candidate.exists() {
                return candidate;
            }
        }
    }
    PathBuf::from(NODE_EXE)
}

/// The Core entry script inside the bundled resources (a few candidate layouts, to be robust).
fn resolve_core_entry(app: &tauri::AppHandle) -> Option<PathBuf> {
    let res = app.path().resource_dir().ok()?;
    [Path::new("core").join("src").join("cli.js"), Path::new("resources").join("core").join("src").join("cli.js")]
        .into_iter()
        .map(|rel| res.join(rel))
        .find(|p| p.exists())
}

fn js_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

fn build_main_window(app: &tauri::AppHandle, conn: &Connection) -> tauri::Result<()> {
    let init = format!("window.__FEROXES__ = {{ url: {}, token: {} }};", js_string(&conn.url), js_string(&conn.token));
    // Prefer the UI the Core serves (same origin as the API). Fall back to the copy bundled in the
    // app if this Core has none (e.g. a background Core run from a repo where the UI isn't built).
    let core_ui = if local_get(conn.port, "/", None) == Some(200) {
        format!("{}/", conn.url.trim_end_matches('/')).parse::<tauri::Url>().ok()
    } else {
        None
    };
    let url = match core_ui {
        Some(u) => WebviewUrl::External(u),
        None => WebviewUrl::App("index.html".into()),
    };
    make_window(app, url, &init)
}

fn build_error_window(app: &tauri::AppHandle, message: &str) -> tauri::Result<()> {
    let init = format!("window.__FEROXES__ = {{ error: {} }};", js_string(message));
    make_window(app, WebviewUrl::App("index.html".into()), &init)
}

fn make_window(app: &tauri::AppHandle, url: WebviewUrl, init_script: &str) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, "main", url)
        .title("Feroxes")
        .inner_size(1280.0, 820.0)
        .min_inner_size(900.0, 600.0)
        .center()
        .initialization_script(init_script)
        .build()?;
    Ok(())
}
