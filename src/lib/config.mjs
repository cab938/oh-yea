import crypto from "node:crypto";
import Ajv from "ajv";
import { parse } from "yaml";
import { SERVICE_ID } from "./caller-token.mjs";

const RETURNS = new Set(["outerHTML", "innerHTML", "textContent", "json"]);
const CAPABILITY_PATTERN = /^[a-z][a-z0-9._-]*$/i;
const HEADER_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const EXTRACTION_TYPES = new Set([
  "css",
  "authenticated_json",
  "browser_json",
  "umgpt_conversation",
]);
const ACTION_TYPES = new Set([
  "teamdynamix_expense_report",
  "teamdynamix_expense_report_capture",
  "umgpt_conversation",
  "umgpt_connector_state",
]);
const BROWSER_JSON_TRANSFORMS = new Set([
  "mcommunity_groups",
  "mcommunity_group",
]);
const schemaValidator = new Ajv({ allErrors: true, strict: false });

export const DEFAULT_CONFIG = `version: 1
authentications: {}
`;

export const DEFAULT_CAPABILITY = `name: new.capability.read
service: arc
description: Describe the narrow result this capability returns
enabled: false
url: https://example.invalid/resource
extraction:
  type: css
  selector: main
  return: textContent
contract:
  input_schema:
    type: object
  output_schema:
    type: string
`;

export class ConfigError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = "ConfigError";
    this.code = "INVALID_CONFIG";
    this.details = details;
  }
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function canonicalUrl(value, field, errors) {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol)) {
      errors.push(`${field} must use http or https`);
      return null;
    }
    if (url.username || url.password) {
      errors.push(`${field} must not contain URL credentials`);
      return null;
    }
    url.hash = "";
    return url.href;
  } catch {
    errors.push(`${field} must be an absolute URL`);
    return null;
  }
}

function normalizeAuthentication(name, configured, field, errors) {
  if (!isPlainObject(configured)) {
    errors.push(`${field} must be an object`);
    return null;
  }

  const type = configured.type ?? "browser_session";
  if (type !== "browser_session") {
    errors.push(`${field}.type must be browser_session`);
    return null;
  }

  const url = canonicalUrl(configured.url, `${field}.url`, errors);
  const loginUrl = canonicalUrl(
    configured.login_url ?? configured.loginUrl,
    `${field}.login_url`,
    errors,
  );
  const configuredDisplayName =
    configured.display_name ?? configured.displayName ?? name;
  let displayName = name;
  if (
    typeof configuredDisplayName !== "string" ||
    configuredDisplayName.trim().length === 0
  ) {
    errors.push(`${field}.display_name must be a non-empty string`);
  } else {
    displayName = configuredDisplayName.trim();
  }

  const configuredSignInGroup =
    configured.sign_in_group ?? configured.signInGroup;
  let signInGroup = null;
  if (configuredSignInGroup !== undefined) {
    if (
      typeof configuredSignInGroup !== "string" ||
      configuredSignInGroup.trim().length === 0
    ) {
      errors.push(`${field}.sign_in_group must be a non-empty string`);
    } else {
      signInGroup = configuredSignInGroup.trim();
    }
  }

  const configuredExpectedExpiry =
    configured.expected_expiry ?? configured.expectedExpiry;
  let expectedExpiry = null;
  if (configuredExpectedExpiry !== undefined) {
    const expiryField = `${field}.expected_expiry`;
    if (!isPlainObject(configuredExpectedExpiry)) {
      errors.push(`${expiryField} must be an object`);
    } else {
      const jsonPointer =
        configuredExpectedExpiry.json_pointer ??
        configuredExpectedExpiry.jsonPointer;
      if (
        typeof jsonPointer !== "string" ||
        (jsonPointer !== "" && !jsonPointer.startsWith("/"))
      ) {
        errors.push(
          `${expiryField}.json_pointer must be an RFC 6901 JSON Pointer`,
        );
      }
      if (configuredExpectedExpiry.format !== "unix_seconds") {
        errors.push(`${expiryField}.format must be unix_seconds`);
      }
      expectedExpiry = {
        jsonPointer,
        format: configuredExpectedExpiry.format,
      };
    }
  }

  return {
    name,
    displayName,
    ...(signInGroup ? { signInGroup } : {}),
    type,
    url,
    loginUrl,
    ...(expectedExpiry ? { expectedExpiry } : {}),
  };
}

function normalizeRequestHeaders(configuredRequestHeaders, field, errors) {
  const requestHeaders = {};
  let dynamicHeaderCount = 0;
  if (
    !isPlainObject(configuredRequestHeaders) ||
    Object.keys(configuredRequestHeaders).length === 0
  ) {
    errors.push(`${field} must be a non-empty object`);
  } else {
    for (const [header, source] of Object.entries(configuredRequestHeaders)) {
      const headerField = `${field}.${header}`;
      if (!HEADER_PATTERN.test(header)) {
        errors.push(`${headerField} is not a valid HTTP header name`);
        continue;
      }
      if (!isPlainObject(source)) {
        errors.push(`${headerField} must be an object`);
        continue;
      }
      const responseHeader = source.response_header ?? source.responseHeader;
      const jsonPointer = source.json_pointer ?? source.jsonPointer;
      const hasValue = Object.hasOwn(source, "value");
      const sourceCount = [
        responseHeader !== undefined,
        jsonPointer !== undefined,
        hasValue,
      ].filter(Boolean).length;
      if (sourceCount !== 1) {
        errors.push(
          `${headerField} must define exactly one of response_header, json_pointer, or value`,
        );
        continue;
      }
      if (
        source.prefix !== undefined &&
        typeof source.prefix !== "string"
      ) {
        errors.push(`${headerField}.prefix must be a string`);
      }
      const prefixValue =
        typeof source.prefix === "string" ? source.prefix : "";
      if (
        responseHeader !== undefined &&
        (typeof responseHeader !== "string" ||
          !HEADER_PATTERN.test(responseHeader))
      ) {
        errors.push(
          `${headerField}.response_header must be a valid HTTP header name`,
        );
        continue;
      }
      if (
        jsonPointer !== undefined &&
        (typeof jsonPointer !== "string" ||
          (jsonPointer !== "" && !jsonPointer.startsWith("/")))
      ) {
        errors.push(
          `${headerField}.json_pointer must be an RFC 6901 JSON Pointer`,
        );
        continue;
      }
      if (
        hasValue &&
        !["string", "number", "boolean"].includes(typeof source.value)
      ) {
        errors.push(`${headerField}.value must be a scalar`);
        continue;
      }
      if (responseHeader !== undefined) {
        dynamicHeaderCount += 1;
        requestHeaders[header] = {
          responseHeader: responseHeader.toLowerCase(),
          prefix: prefixValue,
        };
      } else if (jsonPointer !== undefined) {
        dynamicHeaderCount += 1;
        requestHeaders[header] = {
          jsonPointer,
          prefix: prefixValue,
        };
      } else {
        requestHeaders[header] = {
          value: String(source.value),
          prefix: prefixValue,
        };
      }
    }
  }
  if (dynamicHeaderCount === 0) {
    errors.push(
      `${field} must include an identity response source`,
    );
  }

  return requestHeaders;
}

function normalizeContract(configured, field, errors) {
  if (!isPlainObject(configured)) {
    errors.push(`${field} must be an object`);
    return null;
  }

  const inputSchema = configured.input_schema ?? configured.inputSchema;
  const outputSchema = configured.output_schema ?? configured.outputSchema;
  const schemas = [
    ["input_schema", inputSchema],
    ["output_schema", outputSchema],
  ];
  for (const [name, schema] of schemas) {
    if (!(isPlainObject(schema) || typeof schema === "boolean")) {
      errors.push(`${field}.${name} must be a JSON Schema object or boolean`);
      continue;
    }
    if (!schemaValidator.validateSchema(schema)) {
      const details = schemaValidator.errors
        ?.map((error) => `${error.instancePath || "/"} ${error.message}`)
        .join(", ");
      errors.push(
        `${field}.${name} is not valid JSON Schema${details ? `: ${details}` : ""}`,
      );
    }
  }

  return { inputSchema, outputSchema };
}

function positiveInteger(value, field, errors, { optional = false } = {}) {
  if (optional && value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) {
    errors.push(`${field} must be a positive integer`);
    return null;
  }
  return value;
}

function normalizeExpenseAction(configured, field, errors) {
  const formUrl = canonicalUrl(
    configured.form_url ?? configured.formUrl,
    `${field}.form_url`,
    errors,
  );
  const submitUrl = canonicalUrl(
    configured.submit_url ?? configured.submitUrl,
    `${field}.submit_url`,
    errors,
  );
  const confirmationUrlPrefix = canonicalUrl(
    configured.confirmation_url_prefix ??
      configured.confirmationUrlPrefix,
    `${field}.confirmation_url_prefix`,
    errors,
  );
  if (formUrl && submitUrl && confirmationUrlPrefix) {
    const origins = new Set(
      [formUrl, submitUrl, confirmationUrlPrefix].map(
        (value) => new URL(value).origin,
      ),
    );
    if (origins.size !== 1) {
      errors.push(
        `${field} form, submit, and confirmation URLs must share one origin`,
      );
    }
  }
  const formId = positiveInteger(
    configured.form_id ?? configured.formId,
    `${field}.form_id`,
    errors,
  );

  const fieldMappings = {};
  const configuredMappings =
    configured.field_mappings ?? configured.fieldMappings;
  if (
    !isPlainObject(configuredMappings) ||
    Object.keys(configuredMappings).length === 0
  ) {
    errors.push(`${field}.field_mappings must be a non-empty object`);
  } else {
    for (const [semanticName, configuredMapping] of Object.entries(
      configuredMappings,
    )) {
      const mappingField = `${field}.field_mappings.${semanticName}`;
      if (!/^[a-z][a-z0-9_]*$/u.test(semanticName)) {
        errors.push(
          `${mappingField} name must start with a letter and contain only lowercase letters, numbers, or _`,
        );
        continue;
      }
      if (!isPlainObject(configuredMapping)) {
        errors.push(`${mappingField} must be an object`);
        continue;
      }
      const name = configuredMapping.name;
      if (
        typeof name !== "string" ||
        !/^attribute\d+(?:\.Content)?$/u.test(name)
      ) {
        errors.push(
          `${mappingField}.name must be a fixed TeamDynamix attribute field`,
        );
      }
      const kind = configuredMapping.kind ?? "text";
      if (!["text", "date", "select", "checklist"].includes(kind)) {
        errors.push(
          `${mappingField}.kind must be text, date, select, or checklist`,
        );
      }
      let choices;
      if (["select", "checklist"].includes(kind)) {
        if (
          !isPlainObject(configuredMapping.choices) ||
          Object.keys(configuredMapping.choices).length === 0
        ) {
          errors.push(`${mappingField}.choices must be a non-empty object`);
        } else {
          choices = {};
          for (const [choice, value] of Object.entries(
            configuredMapping.choices,
          )) {
            if (
              !["string", "number"].includes(typeof value) ||
              String(value).length === 0
            ) {
              errors.push(
                `${mappingField}.choices.${choice} must be a non-empty string or number`,
              );
              continue;
            }
            choices[choice] = String(value);
          }
        }
      } else if (configuredMapping.choices !== undefined) {
        errors.push(
          `${mappingField}.choices is supported only for select or checklist fields`,
        );
      }
      fieldMappings[semanticName] = {
        name,
        kind,
        ...(choices ? { choices } : {}),
      };
    }
  }

  const configuredAttachments = configured.attachments ?? {};
  if (!isPlainObject(configuredAttachments)) {
    errors.push(`${field}.attachments must be an object`);
  }
  const attachmentConfig = isPlainObject(configuredAttachments)
    ? configuredAttachments
    : {};
  const allowedExtensions =
    attachmentConfig.allowed_extensions ??
    attachmentConfig.allowedExtensions ??
    [".pdf", ".jpg", ".jpeg", ".png"];
  if (
    !Array.isArray(allowedExtensions) ||
    allowedExtensions.length === 0 ||
    allowedExtensions.some(
      (extension) =>
        typeof extension !== "string" ||
        !/^\.[a-z0-9]+$/u.test(extension),
    )
  ) {
    errors.push(
      `${field}.attachments.allowed_extensions must contain extensions such as .pdf`,
    );
  }
  const maxFiles = positiveInteger(
    attachmentConfig.max_files ?? attachmentConfig.maxFiles ?? 20,
    `${field}.attachments.max_files`,
    errors,
  );
  const maxFileBytes = positiveInteger(
    attachmentConfig.max_file_bytes ??
      attachmentConfig.maxFileBytes ??
      20 * 1024 * 1024,
    `${field}.attachments.max_file_bytes`,
    errors,
  );
  const maxTotalBytes = positiveInteger(
    attachmentConfig.max_total_bytes ??
      attachmentConfig.maxTotalBytes ??
      50 * 1024 * 1024,
    `${field}.attachments.max_total_bytes`,
    errors,
  );
  const attachmentFieldName =
    attachmentConfig.field_name ??
    attachmentConfig.fieldName ??
    "files";
  if (
    typeof attachmentFieldName !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(attachmentFieldName)
  ) {
    errors.push(`${field}.attachments.field_name must be a form field name`);
  }

  const referencePrefix =
    configured.reference_prefix ?? configured.referencePrefix ?? "TDX";
  if (
    typeof referencePrefix !== "string" ||
    !/^[A-Za-z0-9._-]{1,20}$/u.test(referencePrefix)
  ) {
    errors.push(
      `${field}.reference_prefix must contain 1 to 20 letters, numbers, ., _ or -`,
    );
  }

  return {
    type: configured.type,
    formUrl,
    submitUrl,
    confirmationUrlPrefix,
    formId,
    fieldMappings,
    attachments: {
      fieldName: attachmentFieldName,
      allowedExtensions: Array.isArray(allowedExtensions)
        ? allowedExtensions.map((extension) => extension.toLowerCase())
        : [],
      maxFiles,
      maxFileBytes,
      maxTotalBytes,
    },
    referencePrefix,
  };
}

function validatePointer(pointer, field, errors) {
  if (typeof pointer !== "string" || (pointer !== "" && !pointer.startsWith("/"))) {
    errors.push(`${field} must be an RFC 6901 JSON Pointer`);
  }
}

function requireAuthentication(authentication, prefix, usage, errors) {
  if (!authentication) errors.push(`${prefix}.authentication is required for ${usage}`);
}

function normalizeExtraction(configured, prefix, url, authentication, errors) {
  let extraction = null;
  const type = configured.type;
  if (!EXTRACTION_TYPES.has(type)) {
    errors.push(
      `${prefix}.extraction.type must be css, authenticated_json, browser_json, or umgpt_conversation`,
    );
  } else if (type === "umgpt_conversation") {
    if (!["models", "connectors", "list", "read"].includes(configured.operation)) {
      errors.push(`${prefix}.extraction.operation must be models, connectors, list, or read`);
    }
    extraction = { type, operation: configured.operation };
  } else if (type === "css") {
    if (
      typeof configured.selector !== "string" ||
      configured.selector.trim() === ""
    ) {
      errors.push(
        `${prefix}.extraction.selector must be a non-empty string`,
      );
    }
    if (!RETURNS.has(configured.return ?? "outerHTML")) {
      errors.push(
        `${prefix}.extraction.return must be outerHTML, innerHTML, textContent, or json`,
      );
    }
    extraction = {
      type,
      selector: configured.selector,
      return: configured.return ?? "outerHTML",
    };
  } else if (type === "authenticated_json") {
    validatePointer(configured.pointer, `${prefix}.extraction.pointer`, errors);
    requireAuthentication(authentication, prefix, "authenticated_json extraction", errors);
    const configuredRequestHeaders =
      configured.request_headers ??
      configured.requestHeaders;
    const requestHeaders = normalizeRequestHeaders(
      configuredRequestHeaders,
      `${prefix}.extraction.request_headers`,
      errors,
    );
    extraction = {
      type,
      pointer: configured.pointer,
      requestHeaders,
    };
  } else {
    const responseUrl = canonicalUrl(
      configured.response_url ??
        configured.responseUrl,
      `${prefix}.extraction.response_url`,
      errors,
    );
    const responseMethod =
      configured.response_method ??
      configured.responseMethod ??
      "GET";
    if (responseMethod !== "GET") {
      errors.push(
        `${prefix}.extraction.response_method must be GET`,
      );
    }
    validatePointer(configured.pointer, `${prefix}.extraction.pointer`, errors);
    requireAuthentication(authentication, prefix, "browser_json extraction", errors);
    if (url && responseUrl) {
      const pageOrigin = new URL(url).origin;
      const responseOrigin = new URL(responseUrl).origin;
      if (pageOrigin !== responseOrigin) {
        errors.push(
          `${prefix}.extraction.response_url must have the same origin as url`,
        );
      }
    }

    const transform = configured.transform;
    if (
      transform !== undefined &&
      !BROWSER_JSON_TRANSFORMS.has(transform)
    ) {
      errors.push(
        `${prefix}.extraction.transform must be mcommunity_groups or mcommunity_group`,
      );
    }
    if (transform && configured.pointer !== "") {
      errors.push(
        `${prefix}.extraction.pointer must be empty when transform is configured`,
      );
    }
    extraction = {
      type,
      responseUrl,
      responseMethod,
      pointer: configured.pointer,
      ...(transform ? { transform } : {}),
    };
  }
  return extraction;
}

function normalizeAction(configured, prefix, authentication, errors) {
  let action = null;
  const type = configured.type;
  if (!ACTION_TYPES.has(type)) {
    errors.push(
      `${prefix}.action.type must be teamdynamix_expense_report, teamdynamix_expense_report_capture, umgpt_conversation, or umgpt_connector_state`,
    );
  } else if (type === "umgpt_conversation" || type === "umgpt_connector_state") {
    action = {
      type,
      pageUrl: canonicalUrl(configured.page_url, `${prefix}.action.page_url`, errors),
    };
  } else {
    requireAuthentication(authentication, prefix, "a TeamDynamix expense action", errors);
    action = normalizeExpenseAction(
      configured,
      `${prefix}.action`,
      errors,
    );
  }
  return action;
}

function validateUmGptProfile(pageUrl, authentication, authentications, prefix, errors) {
  requireAuthentication(authentication, prefix, "UM GPT", errors);
  if (pageUrl) {
    const page = new URL(pageUrl);
    if (page.pathname !== "/" || page.search) {
      errors.push(`${prefix} UM GPT page URL must be the configured origin's root`);
    }
    const profile = authentications[authentication];
    if (profile && (profile.url !== `${page.origin}/umgpt/api/me` ||
        profile.loginUrl !== `${page.origin}/`)) {
      errors.push(`${prefix} UM GPT authentication must use the same origin's /umgpt/api/me and root login URL`);
    }
  }
}

function normalizeCapability(capability, index, authentications, seenNames, errors) {
  const prefix = `capabilities[${index}]`;
  if (!isPlainObject(capability)) {
    errors.push(`${prefix} must be an object`);
    return null;
  }

  if (
    typeof capability.name !== "string" ||
    !CAPABILITY_PATTERN.test(capability.name)
  ) {
    errors.push(
      `${prefix}.name must start with a letter and contain only letters, numbers, ., _ or -`,
    );
  } else if (seenNames.has(capability.name)) {
    errors.push(`${prefix}.name duplicates ${capability.name}`);
  } else {
    seenNames.add(capability.name);
  }

  const hasExtraction = isPlainObject(capability.extraction);
  const hasAction = isPlainObject(capability.action);
  if (hasExtraction === hasAction) {
    errors.push(
      `${prefix} must define exactly one of extraction or action`,
    );
  }
  const url = hasExtraction
    ? canonicalUrl(capability.url, `${prefix}.url`, errors)
    : null;

  if (typeof capability.service !== "string" || !SERVICE_ID.test(capability.service)) {
    errors.push(`${prefix}.service must be a lowercase service name with optional hyphens`);
  }
  if (Object.hasOwn(capability, "tokens") || Object.hasOwn(capability, "token")) {
    errors.push(`${prefix} must use a service token in .env, not capability tokens`);
  }

  let authentication = null;
  if (capability.authentication !== undefined) {
    if (
      typeof capability.authentication !== "string" ||
      capability.authentication.length === 0
    ) {
      errors.push(
        `${prefix}.authentication must name a configured authentication`,
      );
    } else {
      authentication = capability.authentication;
      if (!Object.hasOwn(authentications, authentication)) {
        errors.push(
          `${prefix}.authentication references unknown authentication ${authentication}`,
        );
      }
    }
  }

  const extraction = hasExtraction
    ? normalizeExtraction(capability.extraction, prefix, url, authentication, errors)
    : null;
  const action = hasAction
    ? normalizeAction(capability.action, prefix, authentication, errors)
    : null;
  if (extraction?.type === "umgpt_conversation" ||
      ["umgpt_conversation", "umgpt_connector_state"].includes(action?.type)) {
    validateUmGptProfile(action?.pageUrl ?? url, authentication, authentications, prefix, errors);
  }

  const contract = normalizeContract(
    capability.contract,
    `${prefix}.contract`,
    errors,
  );

  return {
    name: capability.name,
    description:
      typeof capability.description === "string"
        ? capability.description
        : "",
    ...(url ? { url } : {}),
    enabled: capability.enabled !== false,
    service: capability.service,
    ...(authentication ? { authentication } : {}),
    ...(extraction ? { extraction } : {}),
    ...(action ? { action } : {}),
    contract,
  };
}

export function validateConfig(value) {
  const errors = [];

  if (!isPlainObject(value)) {
    throw new ConfigError("Configuration must be a YAML object", [
      "top level must be an object",
    ]);
  }

  if (value.version !== 1) {
    errors.push("version must be 1");
  }

  const authentications = {};
  if (value.authentications !== undefined) {
    if (
      !isPlainObject(value.authentications)
    ) {
      errors.push("authentications must be an object");
    } else {
      for (const [name, configured] of Object.entries(value.authentications)) {
        const field = `authentications.${name}`;
        if (!CAPABILITY_PATTERN.test(name)) {
          errors.push(
            `${field} name must start with a letter and contain only letters, numbers, ., _ or -`,
          );
          continue;
        }
        const authentication = normalizeAuthentication(
          name,
          configured,
          field,
          errors,
        );
        if (authentication) authentications[name] = authentication;
      }
    }
  }

  if (errors.length > 0) {
    throw new ConfigError(
      `Configuration has ${errors.length} validation error${errors.length === 1 ? "" : "s"}`,
      errors,
    );
  }

  return { version: 1, authentications, capabilities: [] };
}

export function parseConfig(text) {
  let value;
  try {
    value = parse(text);
  } catch (error) {
    throw new ConfigError(`YAML could not be parsed: ${error.message}`);
  }
  if (isPlainObject(value) && Object.hasOwn(value, "capabilities")) {
    throw new ConfigError(
      "Capabilities must be stored as individual files under capabilities/",
    );
  }
  return validateConfig(value);
}

export function parseCapability(text, authentications = {}) {
  let capability;
  try {
    capability = parse(text);
  } catch (error) {
    throw new ConfigError(`Capability YAML could not be parsed: ${error.message}`);
  }
  const errors = [];
  const definition = normalizeCapability(capability, 0, authentications, new Set(), errors);
  if (errors.length > 0) {
    throw new ConfigError(
      `Configuration has ${errors.length} validation error${errors.length === 1 ? "" : "s"}`,
      errors,
    );
  }
  return definition;
}

function tokenMatches(candidate, configuredToken) {
  const candidateDigest = crypto
    .createHash("sha256")
    .update(candidate)
    .digest();
  const configuredDigest = crypto
    .createHash("sha256")
    .update(configuredToken)
    .digest();
  return crypto.timingSafeEqual(candidateDigest, configuredDigest);
}

export function authorizeRequest(config, request) {
  if (!isPlainObject(request)) {
    return { ok: false, code: "INVALID_REQUEST", message: "Request must be an object" };
  }

  if (
    typeof request.token !== "string" ||
    typeof request.capability !== "string" ||
    request.capability.length === 0
  ) {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      message: "Request requires token and capability",
    };
  }

  if (
    request.url !== undefined ||
    request.path !== undefined ||
    request.api !== undefined
  ) {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      message: "Agents may request capabilities but may not supply target URLs",
    };
  }

  if (
    request.input !== undefined &&
    !isPlainObject(request.input)
  ) {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      message: "input must be a JSON object",
    };
  }

  const definition = config.capabilities.find((candidate) => {
    if (!candidate.enabled) return false;
    return candidate.name === request.capability;
  });

  if (
    !definition ||
    typeof config.serviceTokens?.[definition.service] !== "string" ||
    !tokenMatches(request.token, config.serviceTokens[definition.service])
  ) {
    return {
      ok: false,
      code: "UNAUTHORIZED",
      message: "Token does not authorize the requested capability's enabled service",
    };
  }

  const inputValidation = validateSchemaValue(
    definition.contract.inputSchema,
    request.input ?? {},
  );
  if (!inputValidation.ok) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "Capability input does not match its contract",
      details: inputValidation.errors,
    };
  }

  return {
    ok: true,
    definition,
    input: request.input ?? {},
  };
}

function validationMessages(errors = []) {
  return errors.map(
    (error) => `${error.instancePath || "/"} ${error.message}`,
  );
}

export function validateSchemaValue(schema, value) {
  const validate = schemaValidator.compile(schema);
  return validate(value)
    ? { ok: true, errors: [] }
    : { ok: false, errors: validationMessages(validate.errors) };
}

export function validateCapabilityResult(definition, value) {
  return validateSchemaValue(definition.contract.outputSchema, value);
}

export function capabilityCatalog(config) {
  return config.capabilities.map((capability) => ({
    name: capability.name,
    service: capability.service,
    description: capability.description,
    enabled: capability.enabled,
    input_schema: capability.contract.inputSchema,
    output_schema: capability.contract.outputSchema,
  }));
}

export function publicConfig(config) {
  return {
    version: config.version,
    authentications: Object.fromEntries(
      Object.entries(config.authentications).map(([name, authentication]) => [
        name,
        authentication,
      ]),
    ),
    capabilities: config.capabilities,
  };
}
