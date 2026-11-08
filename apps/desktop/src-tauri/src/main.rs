// Prevent a second console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    feroxes_desktop_lib::run();
}
