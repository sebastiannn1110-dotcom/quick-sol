"use client";

type ClientLogLevel = "debug" | "info" | "warn" | "error";

async function sendClientLog(level: ClientLogLevel, action: string, message: string, metadata?: Record<string, unknown>) {
  try {
    await fetch("/api/logs/client", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        level,
        action,
        message,
        route: window.location.pathname,
        metadata
      })
    });
  } catch {
    // Client logging must never break UX.
  }
}

async function sendAuthLog(action: "login_success" | "login_failed" | "logout" | "password_reset_requested", metadata?: Record<string, unknown>) {
  try {
    await fetch("/api/logs/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        route: window.location.pathname,
        metadata
      })
    });
  } catch {
    // Auth logging must never block login/logout UX.
  }
}

export const clientLogger = {
  pageView: (metadata?: Record<string, unknown>) =>
    sendClientLog("info", "page_view", "Page viewed", metadata),
  buttonClicked: (action: string, metadata?: Record<string, unknown>) =>
    sendClientLog("info", "button_clicked", action, metadata),
  uploadStarted: (metadata?: Record<string, unknown>) =>
    sendClientLog("info", "upload_ui_started", "Upload UI started", metadata),
  uploadCompleted: (metadata?: Record<string, unknown>) =>
    sendClientLog("info", "upload_ui_completed", "Upload UI completed", metadata),
  uploadFailed: (metadata?: Record<string, unknown>) =>
    sendClientLog("error", "upload_ui_failed", "Upload UI failed", metadata),
  tableFilterChanged: (metadata?: Record<string, unknown>) =>
    sendClientLog("info", "table_filter_changed", "Table filter changed", metadata),
  searchExecuted: (metadata?: Record<string, unknown>) =>
    sendClientLog("info", "search_executed", "Search executed", metadata),
  loginSuccess: (metadata?: Record<string, unknown>) =>
    sendAuthLog("login_success", metadata),
  loginFailed: (metadata?: Record<string, unknown>) =>
    sendAuthLog("login_failed", metadata),
  logout: (metadata?: Record<string, unknown>) =>
    sendAuthLog("logout", metadata),
  passwordResetRequested: (metadata?: Record<string, unknown>) =>
    sendAuthLog("password_reset_requested", metadata),
  reactErrorBoundaryTriggered: (metadata?: Record<string, unknown>) =>
    sendClientLog("error", "react_error_boundary_triggered", "React error boundary triggered", metadata)
};
