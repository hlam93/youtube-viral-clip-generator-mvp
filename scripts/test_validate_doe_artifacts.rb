#!/usr/bin/env ruby
# frozen_string_literal: true

require "minitest/autorun"
require_relative "validate_doe_artifacts"

class ValidateDoeArtifactsTest < Minitest::Test
  def directive(id, extra = {})
    {
      "metadata" => { "directive_id" => id, "title" => "t", "status" => "active", "last_updated" => "2026-01-01" },
      "context" => {}, "delivery" => { "release_slices" => [] }, "security" => { "scope" => "non-business" },
    }.merge(extra)
  end

  def execution(id, refs, extra = {})
    {
      "metadata" => { "execution_id" => id, "title" => "t", "status" => "complete", "directive_refs" => refs, "last_updated" => "2026-01-01" },
      "scope" => {}, "validation" => {},
      "handoff" => { "owners" => { "engineering" => "x" }, "acceptance_criteria" => ["a"], "risk_tier" => "low", "validation_plan" => {}, "release_gates" => ["g"] },
      "quality_gates" => {}, "risk" => { "release_recommendation" => "go" },
    }.merge(extra)
  end

  def test_validate_directive_rejects_bad_id
    errors = validate_directive("d", { "metadata" => { "directive_id" => "BAD-1" } })
    assert(errors.any? { |e| e.include?("directive_id") })
  end

  def test_validate_directive_requires_sections_for_dir
    meta = { "directive_id" => "DIR-0001", "title" => "t", "status" => "s", "last_updated" => "2026-01-01" }
    assert_equal 3, validate_directive("d", { "metadata" => meta }).length
  end

  def test_validate_directive_accepts_valid_dir
    assert_empty validate_directive("d", directive("DIR-0001"))
  end

  def test_validate_directive_rejects_unrecognized_scope_literal
    # Regression test for the drift this exact class of bug caused: docs/templates said
    # "business-app" while the validator matched "business", so the reconciliation check
    # silently never fired for a directive authored per the documented convention.
    errors = validate_directive("d", directive("DIR-0001", "security" => { "scope" => "business-app" }))
    assert(errors.any? { |e| e.include?("security.scope") })
  end

  def test_validate_directive_accepts_business_scope
    assert_empty validate_directive("d", directive("DIR-0001", "security" => { "scope" => "business" }))
  end

  def test_validate_execution_rejects_bad_risk_tier
    bad_handoff = { "owners" => { "x" => "y" }, "acceptance_criteria" => ["a"], "risk_tier" => "nope", "validation_plan" => {}, "release_gates" => ["g"] }
    errors = validate_execution("e", execution("EXE-0001", ["DIR-0001"], "handoff" => bad_handoff))
    assert(errors.any? { |e| e.include?("risk_tier") })
  end

  def test_cross_references_flags_unknown_directive
    dirs = [{ path: "d", id: "DIR-0001", data: directive("DIR-0001") }]
    execs = [{ path: "e", id: "EXE-0001", data: execution("EXE-0001", ["DIR-9999"]) }]
    assert(validate_cross_references(dirs, execs).any? { |e| e.include?("unknown directive") })
  end

  def test_cross_references_flags_missing_backreference
    dirs = [{ path: "d", id: "DIR-0001", data: directive("DIR-0001") }]
    execs = [{ path: "e", id: "EXE-0001", data: execution("EXE-0001", ["DIR-0001"]) }]
    assert(validate_cross_references(dirs, execs).any? { |e| e.include?("traceability drift") })
  end

  def test_cross_references_passes_when_bidirectional
    dirs = [{ path: "d", id: "DIR-0001", data: directive("DIR-0001", "delivery" => { "release_slices" => ["EXE-0001"] }) }]
    execs = [{ path: "e", id: "EXE-0001", data: execution("EXE-0001", ["DIR-0001"]) }]
    assert_empty validate_cross_references(dirs, execs)
  end

  def test_unique_ids_flags_duplicate_directive
    dirs = [
      { path: "d1", id: "DIR-0001", data: directive("DIR-0001") },
      { path: "d2", id: "DIR-0001", data: directive("DIR-0001") },
    ]
    errors = validate_unique_ids(dirs, "directive")
    assert(errors.any? { |e| e.include?("duplicate directive id 'DIR-0001'") && e.include?("d1") && e.include?("d2") })
  end

  def test_unique_ids_passes_for_distinct_ids
    dirs = [
      { path: "d1", id: "DIR-0001", data: directive("DIR-0001") },
      { path: "d2", id: "DIR-0002", data: directive("DIR-0002") },
    ]
    assert_empty validate_unique_ids(dirs, "directive")
  end

  def test_risk_tier_reconciliation_flags_business_low_without_override
    dirs = [{ path: "d", id: "DIR-0001", data: directive("DIR-0001", "security" => { "scope" => "business" }) }]
    execs = [{ path: "e", id: "EXE-0001", data: execution("EXE-0001", ["DIR-0001"]) }]
    assert(validate_risk_tier_reconciliation(dirs, execs).any? { |e| e.include?("business-scope") })
  end

  def test_risk_tier_reconciliation_allows_override
    dirs = [{ path: "d", id: "DIR-0001", data: directive("DIR-0001", "security" => { "scope" => "business" }) }]
    data = execution("EXE-0001", ["DIR-0001"])
    data["handoff"]["risk_tier_override_rationale"] = "accepted by QA"
    assert_empty validate_risk_tier_reconciliation(dirs, [{ path: "e", id: "EXE-0001", data: data }])
  end

  def test_iteration_log_bound_flags_too_many_retries
    log = Array.new(3) { { "result" => "resolved" } }
    errors = validate_iteration_log_bound("e", { "iteration_log" => log })
    assert(errors.any? { |e| e.include?("bounds retries to 2") })
  end

  def test_iteration_log_bound_flags_entry_after_escalation
    log = [{ "result" => "escalated-to-user" }, { "result" => "resolved" }]
    errors = validate_iteration_log_bound("e", { "iteration_log" => log })
    assert(errors.any? { |e| e.include?("escalation should end") })
  end

  def test_iteration_log_bound_allows_escalation_as_last_entry
    log = [{ "result" => "resolved" }, { "result" => "escalated-to-user" }]
    assert_empty validate_iteration_log_bound("e", { "iteration_log" => log })
  end

  def test_iteration_log_bound_rejects_unrecognized_result
    # Regression-style test for the same class of bug as security.scope: the retry-cap
    # and escalation logic both depend on an exact string match against "result", so an
    # unvalidated typo would silently miscount instead of being rejected.
    log = [{ "result" => "escalated_to_user" }]
    errors = validate_iteration_log_bound("e", { "iteration_log" => log })
    assert(errors.any? { |e| e.include?("iteration_log[0].result") })
  end

  def test_iteration_log_bound_accepts_deferred_with_residual_risk
    log = [{ "result" => "deferred-with-residual-risk" }]
    assert_empty validate_iteration_log_bound("e", { "iteration_log" => log })
  end

  def test_high_risk_hardening_flags_missing_rollback_and_signoff
    data = { "handoff" => { "risk_tier" => "high", "release_gates" => ["tests pass"] }, "quality_gates" => { "definition_of_done" => {} } }
    assert_equal 2, validate_high_risk_hardening("e", data).length
  end

  def test_high_risk_hardening_rejects_unverified_rollback_text_as_a_substitute
    # Regression test: the old substring-match on release_gates accepted phrasing
    # like "no rollback needed" as satisfying the gate. A typed boolean can't be
    # gamed by free text that merely mentions "rollback".
    data = {
      "handoff" => { "risk_tier" => "high", "release_gates" => ["no rollback needed"] },
      "quality_gates" => { "definition_of_done" => { "security_signoff" => "pass" } },
    }
    errors = validate_high_risk_hardening("e", data)
    assert(errors.any? { |e| e.include?("rollback_verified") })
  end

  def test_high_risk_hardening_passes_when_satisfied
    data = {
      "handoff" => { "risk_tier" => "high", "release_gates" => ["g"], "rollback_verified" => true },
      "quality_gates" => { "definition_of_done" => { "security_signoff" => "pass" } },
    }
    assert_empty validate_high_risk_hardening("e", data)
  end

  def test_high_risk_hardening_dormant_for_low_tier
    assert_empty validate_high_risk_hardening("e", { "handoff" => { "risk_tier" => "low" } })
  end

  def test_no_stray_single_key_list_items_flags_unquoted_colon_prose
    # Regression test for the class of bug EXE-0021 found 29 real instances of: an
    # unquoted "prose: more prose" list item silently parses as a single-key map.
    data = { "scope" => { "in_scope" => ["fine string", { "some clause" => "more prose" }] } }
    errors = validate_no_stray_single_key_list_items("e", data)
    assert(errors.any? { |e| e.include?("scope.in_scope[1]") && e.include?("some clause") })
  end

  def test_no_stray_single_key_list_items_ignores_multi_key_entries
    # iteration_log entries are real multi-key maps by design and must not be flagged.
    log = [{ "trigger" => "t", "finding" => "f", "action_taken" => "a", "result" => "resolved" }]
    assert_empty validate_no_stray_single_key_list_items("e", { "iteration_log" => log })
  end

  def test_no_stray_single_key_list_items_ignores_non_list_maps
    # handoff.owners and quality_gates role-status maps are Hashes, not list items,
    # and must never be flagged regardless of key count.
    data = { "handoff" => { "owners" => { "engineering" => "x" } } }
    assert_empty validate_no_stray_single_key_list_items("e", data)
  end

  def test_no_stray_single_key_list_items_passes_clean_document
    assert_empty validate_no_stray_single_key_list_items("e", execution("EXE-0001", ["DIR-0001"]))
  end
end
