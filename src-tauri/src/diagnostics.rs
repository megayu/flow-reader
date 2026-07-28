use std::{env, time::Duration};

pub(crate) fn enabled() -> bool {
    env::var("FLOW_READER_DIAGNOSTICS")
        .map(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(false)
}

pub(crate) fn record_timing(stage: &str, elapsed: Duration, fields: &[(&str, String)]) {
    if !enabled() {
        return;
    }

    let mut message = format!(
        "flow-reader diagnostic stage={stage} elapsed_ms={:.2}",
        elapsed.as_secs_f64() * 1000.0
    );
    for (key, value) in fields {
        message.push(' ');
        message.push_str(key);
        message.push('=');
        message.push_str(value);
    }
    eprintln!("{message}");
}
