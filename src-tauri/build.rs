fn main() {
    let mut attributes = tauri_build::Attributes::new();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        embed_windows_app_manifest();
    }
    tauri_build::try_build(attributes).expect("failed to prepare the Tauri build");
}

fn embed_windows_app_manifest() {
    let manifest = std::path::PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is required"),
    )
    .join("windows-app-manifest.xml");

    println!("cargo:rerun-if-changed={}", manifest.display());
    // tauri-build normally links its manifest only to application binaries.
    // These package-wide arguments also cover the Windows test harnesses.
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    println!("cargo:rustc-link-arg=/WX");
}
