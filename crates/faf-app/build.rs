//! Tells Cargo which environment variables the crate reads at compile time.
//!
//! `option_env!` bakes a value into the binary, and Cargo does not know that on
//! its own: without this, changing `TWITCH_CLIENT_ID` and rebuilding reuses the
//! cached artifact and the old value, which on a CI runner with a warm cache
//! means a release that silently ships no credentials at all.
//!
//! See `TwitchConfig::faf` in `src/infra/streams.rs`.

fn main() {
    for key in ["TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET"] {
        println!("cargo:rerun-if-env-changed={key}");
    }
}
