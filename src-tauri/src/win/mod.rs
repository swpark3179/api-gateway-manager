//! Windows 네이티브 창 동작 보강.
//!
//! 창은 `decorations: false` 로 띄우고 디자인의 38px 커스텀 타이틀바를 그린다.
//! tao(Tauri 내부)가 프레임리스 창의 리사이즈 보더와 `WM_NCCALCSIZE` 는 이미 처리하므로,
//! 여기서는 그것만으로 얻을 수 없는 두 가지를 추가한다:
//!
//! 1. **Snap Layouts** — Windows 11 에서 최대화 버튼에 마우스를 올리면 뜨는 레이아웃 팝업.
//!    `WM_NCHITTEST` 에 `HTMAXBUTTON` 을 돌려줘야 OS 가 팝업을 띄운다. 우리 버튼은
//!    클라이언트 영역에 그려진 HTML 이라 기본값으로는 `HTCLIENT` 가 나온다.
//! 2. **Win11 라운드 코너** — `DWMWA_WINDOW_CORNER_PREFERENCE`.
//!
//! 나머지 메시지는 전부 `DefSubclassProc` 로 넘겨 tao 의 기본 동작을 보존한다.

#![cfg(windows)]

use std::sync::OnceLock;

use tauri::{AppHandle, Emitter, Manager, Wry};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Dwm::{
    DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
};
use windows_sys::Win32::Graphics::Gdi::ScreenToClient;
use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetClientRect, IsZoomed, PostMessageW, HTCLIENT, HTMAXBUTTON, SC_MAXIMIZE, SC_RESTORE,
    WM_NCHITTEST, WM_NCLBUTTONDOWN, WM_NCLBUTTONUP, WM_NCMOUSELEAVE, WM_NCMOUSEMOVE, WM_SYSCOMMAND,
};

/// 디자인 기준 치수 (CSS px). 실제 히트 테스트는 DPI 배율을 곱해 계산한다.
const TITLEBAR_H: f64 = 38.0;
const BUTTON_W: f64 = 44.0;
/// 오른쪽 끝에서부터 [닫기][최대화][최소화] 순으로 44px 씩. 최대화는 두 번째 칸.
const MAX_BUTTON_INDEX_FROM_RIGHT: f64 = 2.0;

const SUBCLASS_ID: usize = 0x4147_4D31; // 'AGM1'

static APP: OnceLock<AppHandle<Wry>> = OnceLock::new();

/// 최대화 버튼 hover 상태를 프런트에 알리는 이벤트 이름.
/// (버튼이 우리 HTML 이라 OS 가 그려주지 않으므로 직접 하이라이트해야 한다)
pub const EVT_MAX_HOVER: &str = "window://max-button-hover";

fn lo_word(v: isize) -> i32 {
    (v & 0xFFFF) as i16 as i32
}
fn hi_word(v: isize) -> i32 {
    ((v >> 16) & 0xFFFF) as i16 as i32
}

fn scale_of(hwnd: HWND) -> f64 {
    let dpi = unsafe { GetDpiForWindow(hwnd) };
    if dpi == 0 { 1.0 } else { dpi as f64 / 96.0 }
}

/// 스크린 좌표가 커스텀 타이틀바의 최대화 버튼 위인지.
unsafe fn over_max_button(hwnd: HWND, lparam: LPARAM) -> bool {
    let mut pt = POINT { x: lo_word(lparam), y: hi_word(lparam) };
    if ScreenToClient(hwnd, &mut pt) == 0 {
        return false;
    }

    let mut rc: RECT = std::mem::zeroed();
    if GetClientRect(hwnd, &mut rc) == 0 {
        return false;
    }

    let s = scale_of(hwnd);
    let bw = BUTTON_W * s;
    let th = TITLEBAR_H * s;

    let right = rc.right as f64;
    let x = pt.x as f64;
    let y = pt.y as f64;

    let x1 = right - bw * MAX_BUTTON_INDEX_FROM_RIGHT;
    let x2 = right - bw * (MAX_BUTTON_INDEX_FROM_RIGHT - 1.0);

    y >= 0.0 && y < th && x >= x1 && x < x2
}

fn emit_hover(state: bool) {
    if let Some(app) = APP.get() {
        let _ = app.emit(EVT_MAX_HOVER, state);
    }
}

unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    match msg {
        // 최대화 버튼 위라면 HTMAXBUTTON 을 돌려줘 Snap Layouts 팝업이 뜨게 한다.
        // 그 외에는 tao 가 계산한 값(리사이즈 보더 포함)을 그대로 쓴다.
        WM_NCHITTEST => {
            let hit = DefSubclassProc(hwnd, msg, wparam, lparam);
            if hit == HTCLIENT as LRESULT && over_max_button(hwnd, lparam) {
                emit_hover(true);
                return HTMAXBUTTON as LRESULT;
            }
            hit
        }

        // HTMAXBUTTON 영역의 클릭은 OS 가 비클라이언트 클릭으로 보낸다.
        // 눌림은 삼키고, 뗄 때 최대화를 토글한다 (Snap Layouts 와 공존).
        WM_NCLBUTTONDOWN if wparam == HTMAXBUTTON as WPARAM => 0,

        WM_NCLBUTTONUP if wparam == HTMAXBUTTON as WPARAM => {
            let cmd = if IsZoomed(hwnd) != 0 { SC_RESTORE } else { SC_MAXIMIZE };
            PostMessageW(hwnd, WM_SYSCOMMAND, cmd as WPARAM, 0);
            0
        }

        WM_NCMOUSEMOVE => {
            emit_hover(wparam == HTMAXBUTTON as WPARAM);
            DefSubclassProc(hwnd, msg, wparam, lparam)
        }

        WM_NCMOUSELEAVE => {
            emit_hover(false);
            DefSubclassProc(hwnd, msg, wparam, lparam)
        }

        _ => DefSubclassProc(hwnd, msg, wparam, lparam),
    }
}

fn set_rounded_corners(hwnd: HWND) {
    // Windows 11 에서만 의미가 있고, 그 이전 버전에서는 조용히 실패한다.
    let pref = DWMWCP_ROUND;
    unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE as u32,
            &pref as *const _ as *const core::ffi::c_void,
            std::mem::size_of_val(&pref) as u32,
        );
    }
}

/// 메인 창에 서브클래스와 DWM 속성을 설치한다. setup 에서 한 번만 호출한다.
pub fn attach(app: &AppHandle<Wry>) {
    let _ = APP.set(app.clone());

    let Some(window) = app.get_webview_window("main") else {
        log::warn!("main 창을 찾지 못해 네이티브 창 보강을 건너뜁니다.");
        return;
    };

    let hwnd = match window.hwnd() {
        Ok(h) => h.0 as HWND,
        Err(e) => {
            log::warn!("HWND 를 얻지 못했습니다: {e}");
            return;
        }
    };

    unsafe {
        if SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, 0) == 0 {
            log::warn!("창 서브클래스 설치에 실패했습니다. Snap Layouts 가 동작하지 않습니다.");
        }
    }
    set_rounded_corners(hwnd);
}
