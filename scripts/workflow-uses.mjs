import yaml from "js-yaml";

const PINNED_REMOTE_USE =
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}$/i;

function pathSegment(key) {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

function displayReference(value) {
  if (typeof value === "string") return value;
  if (value === null) return "<null>";
  if (Array.isArray(value)) return "<array>";
  return `<${typeof value}>`;
}

function parsedWorkflow(workflowText, workflowName) {
  try {
    return yaml.load(workflowText, { filename: workflowName });
  } catch (error) {
    throw new TypeError(
      `Le workflow ${workflowName} n’est pas un document YAML valide : ${error.message}`,
      { cause: error },
    );
  }
}

/**
 * Parse the complete workflow and inspect every `uses` mapping key, including
 * quoted keys, flow mappings, aliases and block scalars. Only immutable remote
 * action/workflow references are accepted. Local and Docker references fail
 * closed because recursively auditing their own dependencies is out of scope
 * for this release guard.
 */
export function findUnsafeWorkflowUses(workflowText, workflowName = "workflow") {
  if (typeof workflowText !== "string") {
    throw new TypeError("Le workflow GitHub doit être fourni sous forme de texte.");
  }

  const workflow = parsedWorkflow(workflowText, workflowName);
  const violations = [];
  const visited = new WeakSet();

  function visit(value, currentPath) {
    if (value === null || typeof value !== "object") return;
    if (visited.has(value)) return;
    visited.add(value);

    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${currentPath}[${index}]`));
      return;
    }

    for (const [key, entry] of Object.entries(value)) {
      const entryPath = `${currentPath}${pathSegment(key)}`;
      if (
        key === "uses" &&
        (typeof entry !== "string" || !PINNED_REMOTE_USE.test(entry))
      ) {
        violations.push({
          workflow: workflowName,
          path: entryPath,
          reference: displayReference(entry),
        });
      }
      visit(entry, entryPath);
    }
  }

  visit(workflow, "$");
  return violations;
}
