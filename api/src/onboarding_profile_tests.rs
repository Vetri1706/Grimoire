use super::*;

#[test]
fn profile_only_accepts_its_display_name_field() {
    assert!(serde_json::from_value::<ProfileInput>(json!({"display_name":"Handler"})).is_ok());
    for extra in [
        "identity_id",
        "organization_id",
        "installation_owner",
        "can_write",
        "passphrase",
    ] {
        let mut input = json!({"display_name":"Handler"});
        input[extra] = json!("unexpected");
        assert!(
            serde_json::from_value::<ProfileInput>(input).is_err(),
            "accepted {extra}"
        );
    }
}

#[test]
fn profile_name_is_trimmed_and_bounded_by_characters() {
    assert_eq!(
        validate_display_name("  Renamed Handler  ").ok().as_deref(),
        Some("Renamed Handler")
    );
    assert!(validate_display_name(&"界".repeat(120)).is_ok());
    assert!(validate_display_name(&"界".repeat(121)).is_err());
    assert!(validate_display_name(" \t ").is_err());
    assert!(validate_display_name("Handler\0Name").is_err());
}

#[test]
fn profile_browser_marker_rejects_missing_and_ambiguous_values() {
    let mut headers = HeaderMap::new();
    assert!(require_browser_request(&headers).is_err());
    headers.insert("X-Grimoire-CSRF", HeaderValue::from_static("1"));
    assert!(require_browser_request(&headers).is_ok());
    headers.append("X-Grimoire-CSRF", HeaderValue::from_static("1"));
    assert!(require_browser_request(&headers).is_err());
}
