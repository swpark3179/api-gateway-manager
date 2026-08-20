// Windows 릴리스 빌드에서 콘솔 창이 뜨지 않도록 한다.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    api_gateway_manager_lib::run()
}
