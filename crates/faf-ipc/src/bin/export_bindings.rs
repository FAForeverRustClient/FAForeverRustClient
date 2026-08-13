//! Writes the generated TypeScript bindings to `ui/src/ipc/bindings.ts`.

use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let ts = faf_ipc::typescript_bindings()?;

    // crates/faf-ipc -> workspace root -> ui/src/ipc/bindings.ts
    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../ui/src/ipc/bindings.ts")
        .canonicalize()
        .unwrap_or_else(|_| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../ui/src/ipc/bindings.ts")
        });

    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&out, ts)?;
    println!("wrote {}", out.display());
    Ok(())
}
