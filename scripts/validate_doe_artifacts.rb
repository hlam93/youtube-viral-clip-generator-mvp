#!/usr/bin/env ruby
# frozen_string_literal: true

require "yaml"
require "date"

ROOT = File.expand_path("..", __dir__)

def yaml_files_for(path_glob)
  Dir.glob(File.join(ROOT, path_glob)).sort
end

def load_yaml(path)
  YAML.safe_load(File.read(path), permitted_classes: [Date, Time], aliases: false)
rescue Psych::SyntaxError => e
  "YAML_PARSE_ERROR: #{e.message}"
end

def valid_iso_date?(value)
  return true if value.is_a?(Date)
  value.is_a?(String) && value.match?(/^\d{4}-\d{2}-\d{2}$/)
end

def validate_metadata(path, data, id_key, id_pattern)
  errors = []

  metadata = data["metadata"]
  unless metadata.is_a?(Hash)
    return ["#{path}: missing metadata map"]
  end

  id_value = metadata[id_key]
  unless id_value.is_a?(String) && id_value.match?(id_pattern)
    errors << "#{path}: metadata.#{id_key} must match #{id_pattern.inspect}"
  end

  errors << "#{path}: metadata.title must be a non-empty string" unless metadata["title"].is_a?(String) && !metadata["title"].strip.empty?
  errors << "#{path}: metadata.status must be a non-empty string" unless metadata["status"].is_a?(String) && !metadata["status"].strip.empty?
  errors << "#{path}: metadata.last_updated must be YYYY-MM-DD" unless valid_iso_date?(metadata["last_updated"])

  errors
end

def validate_directive(path, data)
  errors = validate_metadata(path, data, "directive_id", /^(DIR|SEC)-\d{4}$/)
  return errors unless errors.empty? && data["metadata"].is_a?(Hash)

  directive_id = data["metadata"]["directive_id"]
  if directive_id.start_with?("DIR-")
    %w[context delivery security].each do |field|
      errors << "#{path}: missing top-level '#{field}' section" unless data[field].is_a?(Hash)
    end

    # SYSTEM.md §4's classification is binary; risk-tier reconciliation only ever
    # matches the literal "business" (validate_risk_tier_reconciliation below). An
    # unvalidated free-text scope let docs/templates drift to "business-app" for a
    # long time without this check ever firing to catch it. Only checked when the
    # section itself is present, so a missing `security:` block is reported once
    # (by the top-level-section check above), not twice.
    if data["security"].is_a?(Hash) && !%w[business non-business].include?(data["security"]["scope"])
      errors << "#{path}: security.scope must be one of business|non-business"
    end
  elsif directive_id.start_with?("SEC-")
    %w[scope controls verification].each do |field|
      errors << "#{path}: missing top-level '#{field}' section" unless data[field].is_a?(Hash)
    end
  end

  errors
end

def validate_execution(path, data)
  errors = validate_metadata(path, data, "execution_id", /^EXE-\d{4}$/)
  return errors unless errors.empty?

  %w[scope handoff quality_gates validation risk].each do |field|
    errors << "#{path}: missing top-level '#{field}' section" unless data[field].is_a?(Hash)
  end

  handoff = data["handoff"]
  if handoff.is_a?(Hash)
    owners = handoff["owners"]
    if !owners.is_a?(Hash) || owners.empty?
      errors << "#{path}: handoff.owners must be a non-empty map"
    end

    acceptance = handoff["acceptance_criteria"]
    if !acceptance.is_a?(Array) || acceptance.empty?
      errors << "#{path}: handoff.acceptance_criteria must be a non-empty list"
    end

    risk_tier = handoff["risk_tier"]
    unless %w[low medium high critical].include?(risk_tier)
      errors << "#{path}: handoff.risk_tier must be one of low|medium|high|critical"
    end

    errors << "#{path}: handoff.validation_plan must be a map" unless handoff["validation_plan"].is_a?(Hash)
    gates = handoff["release_gates"]
    if !gates.is_a?(Array) || gates.empty?
      errors << "#{path}: handoff.release_gates must be a non-empty list"
    end
  end

  quality_gates = data["quality_gates"]
  gate_status = %w[pass fail n/a]
  if quality_gates.is_a?(Hash)
    dor = quality_gates["definition_of_ready"]
    dod = quality_gates["definition_of_done"]
    errors << "#{path}: quality_gates.definition_of_ready must be a map" unless dor.is_a?(Hash)
    errors << "#{path}: quality_gates.definition_of_done must be a map" unless dod.is_a?(Hash)

    if dor.is_a?(Hash)
      %w[project_manager ux_ui qa_security ci_enforcement].each do |role|
        next if gate_status.include?(dor[role])

        errors << "#{path}: quality_gates.definition_of_ready.#{role} must be pass|fail|n/a"
      end
    end

    if dod.is_a?(Hash)
      %w[engineering project_manager ux_ui qa_security ci_enforcement orchestrator].each do |role|
        next if gate_status.include?(dod[role])

        errors << "#{path}: quality_gates.definition_of_done.#{role} must be pass|fail|n/a"
      end
    end
  end

  refs = data.dig("metadata", "directive_refs")
  if !refs.is_a?(Array) || refs.empty? || !refs.all? { |ref| ref.is_a?(String) && !ref.strip.empty? }
    errors << "#{path}: metadata.directive_refs must be a non-empty list of directive ids"
  end

  recommendation = data.dig("risk", "release_recommendation")
  unless %w[go go-with-risk no-go].include?(recommendation)
    errors << "#{path}: risk.release_recommendation must be one of go|go-with-risk|no-go"
  end

  errors.concat(validate_iteration_log_bound(path, data))
  errors.concat(validate_high_risk_hardening(path, data))

  errors
end

# SYSTEM.md workflow step 10: bounded to 2 retry cycles per slice before escalating
# to the user, and escalation ends the loop rather than being followed by more
# silent retries.
def validate_iteration_log_bound(path, data)
  errors = []
  log = data["iteration_log"]
  return errors unless log.is_a?(Array)

  entries = log.select { |entry| entry.is_a?(Hash) }

  # result drives exact-match escalation/retry-cap logic below; an unvalidated free-text
  # value (a typo like "escalated_to_user") would silently miscount toward the cap instead
  # of ending it, the same class of bug the security.scope literal mismatch caused.
  valid_results = %w[resolved escalated-to-user deferred-with-residual-risk]
  entries.each_with_index do |entry, index|
    next if valid_results.include?(entry["result"])

    errors << "#{path}: iteration_log[#{index}].result must be one of #{valid_results.join('|')}"
  end

  escalation_index = entries.find_index { |entry| entry["result"] == "escalated-to-user" }
  non_escalated_count = entries.count { |entry| entry["result"] != "escalated-to-user" }

  if non_escalated_count > 2
    errors << "#{path}: iteration_log has #{non_escalated_count} entries without escalating to the user; SYSTEM.md step 10 bounds retries to 2 cycles before escalation"
  end

  if escalation_index && escalation_index < entries.length - 1
    errors << "#{path}: iteration_log has entries after an escalated-to-user result; escalation should end the retry loop for the slice"
  end

  errors
end

# SYSTEM.md §4/§8.1 hardening for high/critical slices: a rollback path must be
# verified, not just documented intent, and a dedicated security sign-off is
# required distinct from general QA.
def validate_high_risk_hardening(path, data)
  errors = []
  tier = data.dig("handoff", "risk_tier")
  return errors unless %w[high critical].include?(tier)

  # A typed boolean, not a substring match on free-text release_gates: a string
  # check for "rollback" was satisfied by phrasing like "no rollback needed",
  # which is the opposite of a verified rollback path.
  unless data.dig("handoff", "rollback_verified") == true
    errors << "#{path}: risk_tier '#{tier}' requires handoff.rollback_verified to be true (a verified rollback path, not only a documented rollback_expectation intent)"
  end

  security_signoff = data.dig("quality_gates", "definition_of_done", "security_signoff")
  unless %w[pass fail].include?(security_signoff)
    errors << "#{path}: risk_tier '#{tier}' requires quality_gates.definition_of_done.security_signoff to be pass|fail (a dedicated security review distinct from qa_security)"
  end

  errors
end

# YAML gotcha: an unquoted "some prose: more prose" list item silently parses as a
# single-key mapping instead of the intended plain string (root-caused as the sole
# mechanism behind 29 real instances found across this repo's own history in
# EXE-0021 — none were an intentional data shape, all were a missing quote). No
# field in this schema ever legitimately holds a list item that is a Hash with
# exactly one key: iteration_log entries always carry all 4 required keys, and
# every other list field (in_scope, acceptance_criteria, residual_risks, etc.) is
# plain strings. So this check is unconditional over the whole document rather
# than scoped to specific fields, and returns zero findings on any currently
# valid file.
def validate_no_stray_single_key_list_items(path, data, trail = [])
  errors = []

  case data
  when Hash
    data.each do |key, value|
      errors.concat(validate_no_stray_single_key_list_items(path, value, trail + [key.to_s]))
    end
  when Array
    data.each_with_index do |item, index|
      if item.is_a?(Hash) && item.size == 1
        field = trail.empty? ? "(root)" : trail.join(".")
        errors << "#{path}: #{field}[#{index}] is a single-key map (#{item.keys.first.inspect}) inside a list — almost certainly an unquoted 'prose: more prose' list item that YAML mis-parsed; quote the whole item as a plain string"
      else
        errors.concat(validate_no_stray_single_key_list_items(path, item, trail + ["[#{index}]"]))
      end
    end
  end

  errors
end

def validate_group(paths, type)
  errors = []
  paths.each do |path|
    loaded = load_yaml(path)
    if loaded.is_a?(String) && loaded.start_with?("YAML_PARSE_ERROR:")
      errors << "#{path}: #{loaded}"
      next
    end

    unless loaded.is_a?(Hash)
      errors << "#{path}: root must be a YAML map"
      next
    end

    errors.concat(type == :directive ? validate_directive(path, loaded) : validate_execution(path, loaded))
    errors.concat(validate_no_stray_single_key_list_items(path, loaded))
  end
  errors
end

# Collects {path, id, data} for every file that parses to a Hash with a string id,
# regardless of other per-file errors, so cross-file checks can still run against
# whatever loaded successfully.
def collect_records(paths, id_key)
  records = []
  paths.each do |path|
    loaded = load_yaml(path)
    next unless loaded.is_a?(Hash)

    id = loaded.dig("metadata", id_key)
    records << { path: path, id: id, data: loaded } if id.is_a?(String)
  end
  records
end

# Referential integrity across the traceability chain: every execution's
# directive_refs must point at a directive that actually exists, and a product
# directive's delivery.release_slices must agree bidirectionally with the
# executions that reference it back (catches manual-sync drift in either file).
def validate_cross_references(directives, executions)
  errors = []
  directive_ids = directives.map { |d| d[:id] }

  directive_slices = {}
  directives.each do |d|
    next unless d[:id].start_with?("DIR-")

    slices = d[:data].dig("delivery", "release_slices")
    directive_slices[d[:id]] = slices.is_a?(Array) ? slices : []
  end

  executions.each do |e|
    refs = e[:data].dig("metadata", "directive_refs")
    next unless refs.is_a?(Array)

    refs.each do |ref|
      next unless ref.is_a?(String)

      unless directive_ids.include?(ref)
        errors << "#{e[:path]}: metadata.directive_refs references unknown directive '#{ref}'"
        next
      end

      next unless directive_slices.key?(ref)

      unless directive_slices[ref].include?(e[:id])
        errors << "#{e[:path]}: references directive '#{ref}', but #{ref}'s delivery.release_slices does not list #{e[:id]} back (traceability drift)"
      end
    end
  end

  directive_slices.each do |dir_id, slices|
    slices.each do |exe_id|
      exe_record = executions.find { |e| e[:id] == exe_id }
      unless exe_record
        errors << "#{dir_id}: delivery.release_slices references unknown execution '#{exe_id}'"
        next
      end

      refs = exe_record[:data].dig("metadata", "directive_refs")
      unless refs.is_a?(Array) && refs.include?(dir_id)
        errors << "#{dir_id}: delivery.release_slices lists #{exe_id}, but #{exe_id}'s metadata.directive_refs does not reference #{dir_id} back (traceability drift)"
      end
    end
  end

  errors
end

# Stable, unique ids are the foundation of the traceability chain (SYSTEM.md §9);
# a copy-pasted template with a forgotten renumber would otherwise silently collide
# (later files overwrite earlier ones in id-keyed lookups with no error).
def validate_unique_ids(records, kind)
  errors = []
  records.group_by { |r| r[:id] }.each do |id, group|
    next unless group.length > 1

    paths = group.map { |r| r[:path] }.join(", ")
    errors << "duplicate #{kind} id '#{id}' found in multiple files: #{paths}"
  end
  errors
end

# SYSTEM.md section 4: business-scope directives default to risk_tier medium-or-higher.
# A lower tier is only allowed with an explicit handoff.risk_tier_override_rationale.
def validate_risk_tier_reconciliation(directives, executions)
  errors = []
  directive_scope = {}
  directives.each do |d|
    next unless d[:id].start_with?("DIR-")

    directive_scope[d[:id]] = d[:data].dig("security", "scope")
  end

  executions.each do |e|
    refs = e[:data].dig("metadata", "directive_refs")
    next unless refs.is_a?(Array)

    business_refs = refs.select { |ref| directive_scope[ref] == "business" }
    next if business_refs.empty?

    tier = e[:data].dig("handoff", "risk_tier")
    next if %w[medium high critical].include?(tier)

    override = e[:data].dig("handoff", "risk_tier_override_rationale")
    next if override.is_a?(String) && !override.strip.empty?

    errors << "#{e[:path]}: handoff.risk_tier is #{tier.inspect} but directive_refs #{business_refs} are business-scope (SYSTEM.md §4 default is medium-or-higher); add a non-empty handoff.risk_tier_override_rationale to justify the exception"
  end

  errors
end

# Guarded so scripts/test_validate_doe_artifacts.rb can require this file for its
# functions without triggering a real run against the repo's own artifacts.
if $PROGRAM_NAME == __FILE__
  directive_paths = yaml_files_for("directives/**/*.yaml")
  execution_paths = yaml_files_for("executions/**/*.yaml")
  all_errors = []

  all_errors.concat(validate_group(directive_paths, :directive))
  all_errors.concat(validate_group(execution_paths, :execution))

  directive_records = collect_records(directive_paths, "directive_id")
  execution_records = collect_records(execution_paths, "execution_id")
  all_errors.concat(validate_unique_ids(directive_records, "directive"))
  all_errors.concat(validate_unique_ids(execution_records, "execution"))
  all_errors.concat(validate_cross_references(directive_records, execution_records))
  all_errors.concat(validate_risk_tier_reconciliation(directive_records, execution_records))

  if all_errors.empty?
    puts "DOE artifact validation passed for #{directive_paths.length} directive file(s) and #{execution_paths.length} execution file(s)."
    exit 0
  end

  puts "DOE artifact validation failed:"
  all_errors.each { |error| puts "- #{error}" }
  exit 1
end
