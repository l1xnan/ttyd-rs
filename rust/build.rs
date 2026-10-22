use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    let manifest_dir = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let source = manifest_dir.join("../html/dist/index.html.gz");
    println!("cargo:rerun-if-changed={}", source.display());

    if !source.is_file() {
        panic!(
            "{} is missing; build the frontend first with `pnpm --dir html build`",
            source.display()
        );
    }

    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR"));
    let destination = out_dir.join("index.html.gz");
    fs::copy(&source, &destination)
        .unwrap_or_else(|error| panic!("failed to copy {}: {error}", source.display()));
}
