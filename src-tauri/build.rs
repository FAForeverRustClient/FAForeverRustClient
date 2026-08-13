use std::{env, path::Path};

fn main() {
    let asset = match env::var("CARGO_CFG_TARGET_OS").as_deref() {
        Ok("windows") => Some("faf-uid.exe"),
        Ok("macos") => Some("faf-uid-macos"),
        Ok("linux") => Some("faf-uid"),
        _ => None,
    };

    // `pnpm tauri` prepares the native helper before a release bundle. Plain
    // Cargo workflows (tests, clippy, IDE checks) neither need nor package it;
    // debug runs resolve the helper directly from the workspace instead.
    let java_adapter = Path::new("..")
        .join("natives")
        .join("java-ice-adapter")
        .join("faf-ice-adapter.jar");
    let java_runtime = Path::new("..")
        .join("natives")
        .join("jre")
        .join("bin")
        .join(if cfg!(windows) { "java.exe" } else { "java" });
    let release_bundle = env::var("PROFILE").as_deref() == Ok("release");
    if (!release_bundle
        || asset.is_none_or(|name| !Path::new("..").join("natives").join(name).is_file())
        || !java_adapter.is_file()
        || !java_runtime.is_file())
        && env::var_os("TAURI_CONFIG").is_none()
    {
        env::set_var("TAURI_CONFIG", r#"{"bundle":{"resources":[]}}"#);
    }

    tauri_build::build();
}
