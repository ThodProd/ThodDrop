fn main() {
    println!("cargo:rerun-if-changed=web/thoddrop.ico");
    #[cfg(windows)]
    winresource::WindowsResource::new()
        .set_icon("web/thoddrop.ico")
        .set("FileDescription", "ThodDrop")
        .set("ProductName", "ThodDrop")
        .compile()
        .expect("Windows executable resources");
}
