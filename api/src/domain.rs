use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    Physical,
    Digital,
    #[default]
    Unspecified,
}

impl Category {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Physical => "physical",
            Self::Digital => "digital",
            Self::Unspecified => "unspecified",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Intake {
    pub name: String,
    #[serde(default)]
    pub product_description: Option<String>,
    #[serde(default)]
    pub product_category: Category,
    #[serde(default)]
    pub decision: Option<String>,
    #[serde(default)]
    pub requirements: Option<Vec<String>>,
    #[serde(default)]
    pub questions: Option<Vec<String>>,
    #[serde(default)]
    pub change_summary: String,
}

impl Intake {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.name.trim().is_empty() || self.name.chars().count() > 160 {
            return Err("Name is required and must be at most 160 characters.");
        }
        if self
            .product_description
            .as_ref()
            .is_some_and(|v| v.chars().count() > 12_000)
        {
            return Err("Product description must be at most 12000 characters.");
        }
        if self
            .decision
            .as_ref()
            .is_some_and(|v| v.chars().count() > 4_000)
        {
            return Err("Decision must be at most 4000 characters.");
        }
        if self.change_summary.chars().count() > 1_000 {
            return Err("Change summary must be at most 1000 characters.");
        }
        for list in [&self.requirements, &self.questions].into_iter().flatten() {
            if list.len() > 100
                || list
                    .iter()
                    .any(|v| v.trim().is_empty() || v.chars().count() > 2_000)
            {
                return Err(
                    "Each list may contain at most 100 nonempty entries, each at most 2000 characters.",
                );
            }
        }
        Ok(())
    }

    pub fn missing(&self) -> Vec<MissingInformation> {
        let mut missing = Vec::new();
        if self
            .product_description
            .as_ref()
            .is_none_or(|v| v.trim().is_empty())
        {
            missing.push(MissingInformation::new(
                "product_description",
                "Product description has not been provided.",
                "Describe what the product is intended to do.",
            ));
        }
        if self.product_category == Category::Unspecified {
            missing.push(MissingInformation::new(
                "product_category",
                "Product category has not been specified.",
                "Identify whether the product is physical or digital.",
            ));
        }
        if self.decision.as_ref().is_none_or(|v| v.trim().is_empty()) {
            missing.push(MissingInformation::new(
                "decision",
                "The decision to be made has not been provided.",
                "State the decision the Handler needs to make.",
            ));
        }
        if self.requirements.is_none() {
            missing.push(MissingInformation::new(
                "requirements",
                "Known requirements have not been recorded.",
                "Record known requirements, or explicitly report that none are known.",
            ));
        }
        match &self.questions {
            None => missing.push(MissingInformation::new(
                "questions",
                "Unresolved questions have not been recorded.",
                "Record unresolved questions, or explicitly report that none are known.",
            )),
            Some(questions) if !questions.is_empty() => missing.push(MissingInformation::new(
                "questions",
                &format!("{} unresolved question(s) remain open.", questions.len()),
                "Resolve the recorded questions using evidence and save a new revision.",
            )),
            _ => (),
        }
        missing
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct MissingInformation {
    pub field: String,
    pub message: String,
    pub next_action: String,
}

impl MissingInformation {
    fn new(field: &str, message: &str, next_action: &str) -> Self {
        Self {
            field: field.into(),
            message: message.into(),
            next_action: next_action.into(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Revision {
    pub number: i32,
    #[serde(flatten)]
    pub intake: Intake,
    pub created_at: DateTime<Utc>,
    pub created_by: Uuid,
}

#[derive(Clone, Debug, Serialize)]
pub struct Scion {
    pub id: Uuid,
    pub current_revision: i32,
    pub revision: Revision,
    pub missing_information: Vec<MissingInformation>,
    pub next_safe_action: String,
    pub category_notice: Option<String>,
}

impl Scion {
    pub fn from_revision(id: Uuid, revision: Revision) -> Self {
        let missing_information = revision.intake.missing();
        let category_notice = match revision.intake.product_category {
            Category::Digital => {
                Some("Intake only — digital vendor comparison unavailable.".into())
            }
            _ => None,
        };
        let next_safe_action = missing_information.first().map(|m| m.next_action.clone()).unwrap_or_else(||
            "Review this Handler-provided draft and gather supporting evidence. Exact scope review and qualification require separate actions; saving intake does not authorize sourcing.".into());
        Self {
            id,
            current_revision: revision.number,
            revision,
            missing_information,
            next_safe_action,
            category_notice,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn incomplete_draft_is_saveable_without_invented_facts() {
        let draft: Intake = serde_json::from_value(json!({"name":"New intake"})).unwrap();
        assert!(draft.validate().is_ok());
        assert_eq!(draft.missing().len(), 5);
        assert!(draft.requirements.is_none());
        assert!(draft.product_description.is_none());
    }

    #[test]
    fn explicit_empty_lists_differ_from_unreported_lists() {
        let draft: Intake =
            serde_json::from_value(json!({"name":"Draft","requirements":[],"questions":[]}))
                .unwrap();
        assert_eq!(draft.missing().len(), 3);
    }

    #[test]
    fn open_questions_are_an_evidence_gap() {
        let draft: Intake = serde_json::from_value(
            json!({"name":"Draft","questions":["Which operating temperature?"]}),
        )
        .unwrap();
        assert!(
            draft
                .missing()
                .iter()
                .any(|m| m.message.contains("1 unresolved"))
        );
    }

    #[test]
    fn authority_and_commercial_fields_are_rejected() {
        for field in [
            "approval",
            "supplier",
            "price",
            "bom",
            "org_id",
            "created_by",
        ] {
            let mut value = json!({"name":"Draft"});
            value[field] = json!("injected");
            assert!(serde_json::from_value::<Intake>(value).is_err(), "{field}");
        }
    }

    #[test]
    fn digital_draft_does_not_claim_vendor_comparison() {
        let intake: Intake =
            serde_json::from_value(json!({"name":"App","product_category":"digital"})).unwrap();
        let scion = Scion::from_revision(
            Uuid::new_v4(),
            Revision {
                number: 1,
                intake,
                created_at: Utc::now(),
                created_by: Uuid::new_v4(),
            },
        );
        assert_eq!(
            scion.category_notice.as_deref(),
            Some("Intake only — digital vendor comparison unavailable.")
        );
    }

    #[test]
    fn reject_blank_name_and_unbounded_list_items() {
        for value in [
            json!({"name":"  "}),
            json!({"name":"Draft","requirements":[""]}),
            json!({"name":"Draft","questions":["a".repeat(2001)]}),
        ] {
            assert!(
                serde_json::from_value::<Intake>(value)
                    .unwrap()
                    .validate()
                    .is_err()
            );
        }
    }
}
