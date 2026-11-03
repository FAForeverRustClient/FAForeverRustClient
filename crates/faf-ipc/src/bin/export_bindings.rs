//! Writes the generated TypeScript bindings to `ui/src/ipc/bindings.ts` and
//! the frontend's starting state to `ui/src/ipc/initialState.ts`.

use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    write("bindings.ts", &faf_ipc::typescript_bindings()?)?;
    write("initialState.ts", &faf_ipc::typescript_initial_state()?)?;
    Ok(())
}

fn write(name: &str, contents: &str) -> Result<(), Box<dyn std::error::Error>> {
    // crates/faf-ipc -> workspace root -> ui/src/ipc/<name>
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../ui/src/ipc")
        .join(name);
    let out = path.canonicalize().unwrap_or(path);

    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&out, contents)?;
    println!("wrote {}", out.display());
    Ok(())
}
