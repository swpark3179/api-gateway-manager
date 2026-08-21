//! API Gateway 관리자 — APISIX Admin API 기반 Windows 데스크톱 앱.

mod apisix;
mod commands;
mod config;
mod db;
mod error;
mod history;
mod jwt;
mod oas;

#[cfg(windows)]
mod win;

#[cfg(test)]
mod tests;

use tauri::Manager;

pub fn run() {
    let mut builder = tauri::Builder::default();

    // 중복 실행 방지 — 이미 떠 있으면 기존 창을 앞으로 가져온다.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Info
                })
                // keyring 은 자격증명 접근마다 DEBUG 3줄을 찍어 로그를 뒤덮는다.
                .level_for("keyring", log::LevelFilter::Warn)
                .build(),
        )
        .plugin(
            // 기본값(StateFlags::all())은 VISIBLE·DECORATIONS 까지 복원한다.
            // VISIBLE 복원은 프런트 준비 전에 창을 띄워 흰 화면을 번쩍이게 하고,
            // DECORATIONS 복원은 커스텀 타이틀바 구성과 충돌할 수 있어 셋만 남긴다.
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .manage(apisix::client::ClientCache::default())
        .manage(history::History::default())
        .setup(|app| {
            let handle = app.handle().clone();

            // Route·Consumer 목록과 OAS Import 비교가 함께 쓰는 메모리 SQLite 캐시.
            // 열지 못하면 목록 화면이 아무것도 못 하므로 조용히 넘기지 않고 기동을 멈춘다.
            app.manage(db::Cache::new().map_err(|e| e.message)?);

            // 저장된 호출 이력 복원 (대시보드 activity)
            history::init(&handle);

            // 커스텀 타이틀바 + Windows 네이티브 동작 보강 (Snap Layouts · 라운드 코너)
            #[cfg(windows)]
            win::attach(&handle);

            // 창은 `visible: false` 로 만들고 프런트가 첫 렌더를 마친 뒤 app_ready 로 띄운다.
            // 프런트가 뜨지 못하면 창이 영영 안 보이므로, 3초 뒤에는 무조건 보여준다.
            // (그래야 사용자가 "앱이 안 켜진다" 대신 실제 오류 화면을 볼 수 있다)
            let fallback = handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(3));
                if let Some(w) = fallback.get_webview_window("main") {
                    if !w.is_visible().unwrap_or(true) {
                        log::warn!("프런트엔드 준비 신호가 오지 않아 창을 강제로 표시합니다.");
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::settings_get,
            commands::settings_save,
            commands::settings_test,
            commands::route_save,
            commands::route_delete,
            commands::routes_sync,
            commands::routes_query,
            commands::route_cached,
            commands::consumers_sync,
            commands::consumers_cached,
            commands::consumer_access_counts,
            commands::oas_load,
            commands::oas_compare,
            commands::consumer_save,
            commands::consumer_delete,
            commands::services_list,
            commands::dashboard,
            commands::jwt_sign,
            commands::gen_secret,
            commands::app_ready,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
