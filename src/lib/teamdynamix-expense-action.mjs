import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const SUBMISSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MIME_TYPES = new Map([
  [".pdf", "application/pdf"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
]);

function actionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function submissionDigest(input, attachments) {
  const digest = crypto.createHash("sha256");
  digest.update(JSON.stringify(stableValue(input)));
  for (const attachment of attachments) {
    digest.update("\0");
    digest.update(attachment.name);
    digest.update("\0");
    digest.update(attachment.data);
  }
  return digest.digest("hex");
}

function canonicalUrl(value) {
  const url = new URL(value);
  url.hash = "";
  return url.href;
}

function scalarValue(semanticName, value) {
  if (
    value === null ||
    !["string", "number", "boolean"].includes(typeof value)
  ) {
    throw actionError(
      "INVALID_INPUT",
      `Expense field ${semanticName} must be a scalar value`,
    );
  }
  return String(value);
}

function mappedChoiceValues(semanticName, mapping, value) {
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => {
    const key = String(item);
    if (!Object.hasOwn(mapping.choices, key)) {
      throw actionError(
        "INVALID_INPUT",
        `Expense field ${semanticName} contains an unsupported value`,
      );
    }
    return { key, value: mapping.choices[key] };
  });
}

function formControl(snapshot, predicate) {
  return snapshot.controls.filter(predicate);
}

function formChanged(message) {
  return actionError(
    "FORM_CHANGED",
    `The configured TeamDynamix expense form no longer matches its broker contract: ${message}`,
  );
}

function entryValues(snapshot, name) {
  return snapshot.entries
    .filter(([entryName]) => entryName === name)
    .map(([, value]) => value);
}

export function validateExpenseFormSnapshot(action, snapshot) {
  if (!snapshot?.found) {
    throw formChanged("the submission form was not found");
  }
  if (
    canonicalUrl(snapshot.actionUrl) !== canonicalUrl(action.submitUrl)
  ) {
    throw formChanged("the form action changed");
  }
  if (snapshot.method !== "POST") {
    throw formChanged("the form method is not POST");
  }
  if (snapshot.enctype.toLowerCase() !== "multipart/form-data") {
    throw formChanged("the form is not multipart");
  }
  if (
    entryValues(snapshot, "FormID").length !== 1 ||
    entryValues(snapshot, "FormID")[0] !== String(action.formId)
  ) {
    throw formChanged("the form identifier changed");
  }
  for (const tokenName of [
    "__RequestVerificationToken",
    "__RequestVerificationTokenPair",
  ]) {
    const tokens = entryValues(snapshot, tokenName);
    if (tokens.length !== 1 || tokens[0].length === 0) {
      throw formChanged(`the ${tokenName} field is unavailable`);
    }
  }

  const fileControls = formControl(
    snapshot,
    (control) =>
      control.type === "file" &&
      control.name === action.attachments.fieldName,
  );
  if (fileControls.length !== 1 || !fileControls[0].multiple) {
    throw formChanged("the receipt attachment field changed");
  }

  const mappingDetails = {};
  for (const [semanticName, mapping] of Object.entries(
    action.fieldMappings,
  )) {
    if (mapping.kind === "select") {
      const controls = formControl(
        snapshot,
        (control) =>
          control.tagName === "select" && control.name === mapping.name,
      );
      if (controls.length !== 1) {
        throw formChanged(`field ${semanticName} is unavailable`);
      }
      const optionValues = new Set(
        controls[0].options.map(({ value }) => value),
      );
      for (const choiceValue of Object.values(mapping.choices)) {
        if (!optionValues.has(choiceValue)) {
          throw formChanged(`a choice for ${semanticName} changed`);
        }
      }
      mappingDetails[semanticName] = { control: controls[0] };
      continue;
    }

    if (mapping.kind === "checklist") {
      const valueFields = formControl(
        snapshot,
        (control) =>
          control.type === "hidden" && control.name === mapping.name,
      );
      const nameFields = formControl(
        snapshot,
        (control) =>
          control.type === "hidden" &&
          control.name === `${mapping.name}Name`,
      );
      if (valueFields.length !== 1 || nameFields.length !== 1) {
        throw formChanged(`checklist ${semanticName} changed`);
      }
      const choices = {};
      for (const [choice, choiceValue] of Object.entries(mapping.choices)) {
        const controls = formControl(
          snapshot,
          (control) =>
            control.type === "checkbox" &&
            control.dataValue === choiceValue &&
            control.name.startsWith(`${mapping.name}Choice`),
        );
        if (
          controls.length !== 1 ||
          controls[0].dataName.length === 0
        ) {
          throw formChanged(`a choice for ${semanticName} changed`);
        }
        choices[choice] = controls[0];
      }
      mappingDetails[semanticName] = { choices };
      continue;
    }

    const controls = formControl(
      snapshot,
      (control) =>
        control.name === mapping.name &&
        ["input", "textarea"].includes(control.tagName) &&
        !["checkbox", "file", "hidden", "radio"].includes(control.type),
    );
    if (controls.length !== 1) {
      throw formChanged(`field ${semanticName} is unavailable`);
    }
    mappingDetails[semanticName] = { control: controls[0] };
  }

  return { snapshot, mappingDetails };
}

function dateForForm(semanticName, value) {
  const text = scalarValue(semanticName, value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text);
  if (!match) {
    throw actionError(
      "INVALID_INPUT",
      `Expense field ${semanticName} must use YYYY-MM-DD`,
    );
  }
  return `${match[2]}/${match[3]}/${match[1]}`;
}

export function buildExpenseFormData(
  action,
  input,
  prepared,
  attachments,
) {
  const fields = input.fields ?? {};
  if (
    fields === null ||
    typeof fields !== "object" ||
    Array.isArray(fields)
  ) {
    throw actionError("INVALID_INPUT", "Expense fields must be an object");
  }
  const unknownFields = Object.keys(fields).filter(
    (name) => !Object.hasOwn(action.fieldMappings, name),
  );
  if (unknownFields.length > 0) {
    throw actionError(
      "INVALID_INPUT",
      `Expense submission contains unmapped fields: ${unknownFields.join(", ")}`,
    );
  }

  const form = new FormData();
  for (const [name, value] of prepared.snapshot.entries) {
    form.append(name, value);
  }

  for (const [semanticName, mapping] of Object.entries(
    action.fieldMappings,
  )) {
    const value = fields[semanticName];
    if (mapping.kind === "checklist") {
      const details = prepared.mappingDetails[semanticName];
      form.delete(mapping.name);
      form.delete(`${mapping.name}Name`);
      for (const control of Object.values(details.choices)) {
        form.delete(control.name);
      }

      const selected =
        value === undefined || value === null || value === ""
          ? []
          : mappedChoiceValues(semanticName, mapping, value);
      const selectedKeys = new Set(selected.map(({ key }) => key));
      for (const [choice, control] of Object.entries(details.choices)) {
        if (selectedKeys.has(choice)) form.append(control.name, "true");
        form.append(control.name, "false");
      }
      form.append(
        mapping.name,
        selected.map(({ value: choiceValue }) => choiceValue).join(","),
      );
      form.append(
        `${mapping.name}Name`,
        selected
          .map(({ key }) => details.choices[key].dataName)
          .join(","),
      );
      continue;
    }

    form.delete(mapping.name);
    if (value === undefined || value === null || value === "") {
      form.append(mapping.name, "");
      continue;
    }
    if (mapping.kind === "select") {
      const [choice] = mappedChoiceValues(
        semanticName,
        mapping,
        value,
      );
      if (Array.isArray(value) || !choice) {
        throw actionError(
          "INVALID_INPUT",
          `Expense field ${semanticName} must contain one choice`,
        );
      }
      form.append(mapping.name, choice.value);
      continue;
    }
    form.append(
      mapping.name,
      mapping.kind === "date"
        ? dateForForm(semanticName, value)
        : scalarValue(semanticName, value),
    );
  }

  for (const attachment of attachments) {
    form.append(
      action.attachments.fieldName,
      new Blob([attachment.data], { type: attachment.mediaType }),
      attachment.name,
    );
  }
  return form;
}

export async function freezeExpenseAttachments(input, action) {
  const configured = input.attachments;
  if (!Array.isArray(configured) || configured.length === 0) {
    throw actionError(
      "INVALID_INPUT",
      "Expense submission requires at least one attachment",
    );
  }
  if (configured.length > action.attachments.maxFiles) {
    throw actionError(
      "ATTACHMENT_LIMIT_EXCEEDED",
      "Expense submission contains too many attachments",
    );
  }

  const attachments = [];
  let totalBytes = 0;
  for (const item of configured) {
    if (
      item === null ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      typeof item.path !== "string" ||
      !path.isAbsolute(item.path)
    ) {
      throw actionError(
        "INVALID_INPUT",
        "Each attachment requires an absolute path",
      );
    }
    const source = path.resolve(item.path);
    const sourceStats = await fs.lstat(source).catch(() => null);
    if (!sourceStats?.isFile() || sourceStats.isSymbolicLink()) {
      throw actionError(
        "INVALID_ATTACHMENT",
        "Each attachment must be a regular non-symlink file",
      );
    }
    const name = item.name ?? path.basename(source);
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      path.basename(name) !== name
    ) {
      throw actionError(
        "INVALID_ATTACHMENT",
        "Attachment names must be plain filenames",
      );
    }
    const extension = path.extname(name).toLowerCase();
    if (!action.attachments.allowedExtensions.includes(extension)) {
      throw actionError(
        "UNSUPPORTED_ATTACHMENT",
        `Attachment ${name} has an unsupported file type`,
      );
    }
    const data = await fs.readFile(source);
    if (data.byteLength > action.attachments.maxFileBytes) {
      throw actionError(
        "ATTACHMENT_LIMIT_EXCEEDED",
        `Attachment ${name} exceeds the configured size limit`,
      );
    }
    totalBytes += data.byteLength;
    if (totalBytes > action.attachments.maxTotalBytes) {
      throw actionError(
        "ATTACHMENT_LIMIT_EXCEEDED",
        "Expense attachments exceed the configured total size limit",
      );
    }
    attachments.push({
      name,
      mediaType: MIME_TYPES.get(extension) ?? "application/octet-stream",
      data,
    });
  }
  return attachments;
}

function stringFormValues(form, name) {
  return form
    .getAll(name)
    .filter((value) => typeof value === "string");
}

function capturedField(input, prepared, form, semanticName, mapping) {
  const rendered = [];
  const names = new Set([mapping.name]);
  if (mapping.kind === "checklist") {
    names.add(`${mapping.name}Name`);
    for (const control of Object.values(
      prepared.mappingDetails[semanticName].choices,
    )) {
      names.add(control.name);
    }
  }
  for (const name of names) {
    rendered.push({
      name,
      values: stringFormValues(form, name),
    });
  }
  return {
    semantic_name: semanticName,
    semantic_value: stableValue(input.fields?.[semanticName] ?? null),
    rendered,
  };
}

async function capturePreparedExpense({
  action,
  input,
  prepared,
  form,
  attachments,
  captureDirectory,
}) {
  const captureId = crypto.randomUUID();
  const captureReference = `CAPTURE-${captureId}`;
  const capturedAt = new Date().toISOString();
  const artifact = {
    version: 1,
    capture_reference: captureReference,
    captured_at: capturedAt,
    submission_id: input.submission_id,
    intended_request: {
      method: "POST",
      url: action.submitUrl,
      enctype: "multipart/form-data",
      form_id: action.formId,
      anti_forgery: [
        {
          name: "__RequestVerificationToken",
          present:
            stringFormValues(
              form,
              "__RequestVerificationToken",
            ).length === 1,
          value: "[redacted]",
        },
        {
          name: "__RequestVerificationTokenPair",
          present:
            stringFormValues(
              form,
              "__RequestVerificationTokenPair",
            ).length === 1,
          value: "[redacted]",
        },
      ],
      fields: Object.entries(action.fieldMappings).map(
        ([semanticName, mapping]) =>
          capturedField(
            input,
            prepared,
            form,
            semanticName,
            mapping,
          ),
      ),
      attachments: attachments.map((attachment) => ({
        field_name: action.attachments.fieldName,
        name: attachment.name,
        media_type: attachment.mediaType,
        bytes: attachment.data.byteLength,
      })),
    },
  };

  try {
    await fs.mkdir(captureDirectory, { recursive: true, mode: 0o700 });
    await fs.chmod(captureDirectory, 0o700);
    const artifactPath = path.join(captureDirectory, `${captureId}.json`);
    await fs.writeFile(
      artifactPath,
      `${JSON.stringify(artifact, null, 2)}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      },
    );
    await fs.chmod(artifactPath, 0o600);
  } catch {
    throw actionError(
      "CAPTURE_RECORD_FAILED",
      "The prepared expense request could not be recorded for inspection",
    );
  }

  return {
    submission_id: input.submission_id,
    status: "captured",
    capture_reference: captureReference,
    attachments: {
      requested: attachments.length,
      captured: attachments.length,
      items: attachments.map((attachment) => ({
        name: attachment.name,
        status: "captured",
        media_type: attachment.mediaType,
        bytes: attachment.data.byteLength,
      })),
    },
  };
}

class SubmissionJournal {
  constructor(directory) {
    this.directory = directory;
  }

  #path(submissionId) {
    return path.join(this.directory, `${submissionId}.json`);
  }

  async #write(record) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    const target = this.#path(record.submissionId);
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(temporary, target);
    await fs.chmod(target, 0o600);
  }

  async existing(submissionId, digest) {
    let existing;
    try {
      existing = JSON.parse(
        await fs.readFile(this.#path(submissionId), "utf8"),
      );
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw actionError(
        "SUBMISSION_RECORD_BROKEN",
        "The expense submission record could not be read",
      );
    }
    if (existing.digest !== digest) {
      throw actionError(
        "SUBMISSION_CONFLICT",
        "The submission ID was already used for different content",
      );
    }
    if (existing.result) return existing.result;
    throw actionError(
      "SUBMISSION_ALREADY_ATTEMPTED",
      "This expense submission was already attempted; inspect its broker record before taking further action",
    );
  }

  async begin(submissionId, digest, attachmentNames) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    const target = this.#path(submissionId);
    let handle;
    try {
      handle = await fs.open(target, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw actionError(
          "SUBMISSION_RECORD_BROKEN",
          "The expense submission record could not be created",
        );
      }
    }
    if (!handle) {
      let existing;
      try {
        existing = JSON.parse(await fs.readFile(target, "utf8"));
      } catch {
        throw actionError(
          "SUBMISSION_RECORD_BROKEN",
          "The expense submission record could not be read",
        );
      }
      if (existing.digest !== digest) {
        throw actionError(
          "SUBMISSION_CONFLICT",
          "The submission ID was already used for different content",
        );
      }
      if (existing.result) return { existingResult: existing.result };
      throw actionError(
        "SUBMISSION_ALREADY_ATTEMPTED",
        "This expense submission was already attempted; inspect its broker record before taking further action",
      );
    }

    const now = new Date().toISOString();
    const record = {
      version: 1,
      submissionId,
      digest,
      state: "ready_to_submit",
      createdAt: now,
      updatedAt: now,
      attachments: attachmentNames.map((name) => ({
        name,
        status: "pending",
      })),
    };
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
    return { record };
  }

  async update(record, changes) {
    Object.assign(record, changes, { updatedAt: new Date().toISOString() });
    await this.#write(record);
  }
}

function ticketIdFromUrl(value, baseUrl) {
  if (!value) return null;
  let url;
  try {
    url = new URL(value, baseUrl);
  } catch {
    return null;
  }
  for (const name of ["TicketID", "TicketId", "ticketId", "ID", "id"]) {
    const candidate = url.searchParams.get(name);
    if (/^\d+$/u.test(candidate ?? "")) return candidate;
  }
  const pathMatch =
    /\/(?:TicketRequestDetails|TicketRequests|Tickets)\/(\d+)(?:\/|$)/u.exec(
      url.pathname,
    );
  return pathMatch?.[1] ?? null;
}

function ticketIdFromText(text) {
  const visibleText = text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]*>/gu, " ")
    .replace(/&(?:nbsp|#160);/giu, " ")
    .replace(/&colon;/giu, ":")
    .replace(/\s+/gu, " ");
  for (const [candidate, patterns] of [
    [
      visibleText,
      [
        /Service\s+Request\s+ID\s*:?\s*(\d{3,})/iu,
        /(?:TicketID|TicketId|ticketId|Ticket ID|Request ID)[^0-9]{0,20}(\d{3,})/u,
      ],
    ],
    [
      text,
      [
        /(?:TicketRequestDetails|TicketRequests|Tickets)\/(\d+)(?:[/?#"' ]|$)/u,
      ],
    ],
  ]) {
    for (const pattern of patterns) {
      const match = pattern.exec(candidate);
      if (match) return match[1];
    }
  }
  return null;
}

function unknownSubmissionOutcome(message) {
  return actionError(
    "SUBMISSION_OUTCOME_UNKNOWN",
    `${message}; inspect TeamDynamix My Requests before taking another action`,
  );
}

async function successfulTicketId(response, action) {
  const location = response.headers.get("location");
  const redirect =
    response.status >= 300 && response.status < 400 && location
      ? new URL(location, action.submitUrl)
      : null;
  if (redirect) {
    const prefix = new URL(action.confirmationUrlPrefix);
    if (
      redirect.origin !== prefix.origin ||
      !redirect.pathname.startsWith(prefix.pathname)
    ) {
      throw unknownSubmissionOutcome(
        "TeamDynamix returned an unexpected post-submission location",
      );
    }
    const ticketId = ticketIdFromUrl(redirect.href, action.submitUrl);
    if (ticketId) return ticketId;
  }

  if (response.status >= 200 && response.status < 300) {
    const responseUrl = response.url
      ? new URL(response.url, action.submitUrl)
      : new URL(action.submitUrl);
    const submitUrl = new URL(action.submitUrl);
    const prefix = new URL(action.confirmationUrlPrefix);
    const remainedOnSubmit =
      responseUrl.origin === submitUrl.origin &&
      responseUrl.pathname === submitUrl.pathname;
    const reachedConfirmation =
      responseUrl.origin === prefix.origin &&
      responseUrl.pathname.startsWith(prefix.pathname);
    if (!remainedOnSubmit && !reachedConfirmation) {
      throw unknownSubmissionOutcome(
        "TeamDynamix returned an unexpected post-submission location",
      );
    }
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > 5 * 1024 * 1024) {
      throw actionError(
        "INVALID_UPSTREAM_RESPONSE",
        "TeamDynamix returned an oversized confirmation response",
      );
    }
    const ticketId =
      ticketIdFromUrl(response.url, action.submitUrl) ??
      ticketIdFromText(body);
    if (ticketId) return ticketId;
    if (
      body.includes("form.js-entry-form") ||
      body.includes("js-entry-form")
    ) {
      throw actionError(
        "TEAM_DYNAMIX_FORM_REJECTED",
        "TeamDynamix returned the expense form without creating a ticket",
      );
    }
  }

  throw unknownSubmissionOutcome(
    `TeamDynamix did not confirm the expense submission (status ${response.status})`,
  );
}

export async function executeTeamDynamixExpenseReport({
  fetch,
  formSnapshot,
  definition,
  input,
  journalDirectory,
  captureDirectory,
  onEvent,
}) {
  const action = definition.action;
  const captureOnly =
    action.type === "teamdynamix_expense_report_capture";
  const submissionId = input.submission_id;
  if (
    typeof submissionId !== "string" ||
    !SUBMISSION_ID.test(submissionId)
  ) {
    throw actionError(
      "INVALID_INPUT",
      "submission_id must contain only letters, numbers, ., _ or -",
    );
  }

  const attachments = await freezeExpenseAttachments(input, action);
  let digest;
  let journal;
  if (!captureOnly) {
    digest = submissionDigest(input, attachments);
    journal = new SubmissionJournal(journalDirectory);
    const existingResult = await journal.existing(submissionId, digest);
    if (existingResult) return existingResult;
  }

  const snapshot = await formSnapshot({
    pageUrl: action.formUrl,
    timeoutMs: 30_000,
  });
  const prepared = validateExpenseFormSnapshot(action, snapshot);
  const form = buildExpenseFormData(action, input, prepared, attachments);
  if (captureOnly) {
    const result = await capturePreparedExpense({
      action,
      input,
      prepared,
      form,
      attachments,
      captureDirectory,
    });
    onEvent?.("captured", {
      submissionId,
      captureReference: result.capture_reference,
      attachmentCount: attachments.length,
    });
    return result;
  }

  const started = await journal.begin(
    submissionId,
    digest,
    attachments.map(({ name }) => name),
  );
  if (started.existingResult) return started.existingResult;
  const { record } = started;
  onEvent?.("started", {
    submissionId,
    attachmentCount: attachments.length,
  });

  let response;
  try {
    await journal.update(record, { state: "submitting" });
    response = await fetch(action.submitUrl, {
      method: "POST",
      credentials: "include",
      redirect: "follow",
      cache: "no-store",
      headers: {
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      },
      referrer: action.formUrl,
      body: form,
      signal: AbortSignal.timeout(90_000),
    });
  } catch {
    await journal.update(record, {
      state: "outcome_unknown",
      errorCode: "SUBMISSION_OUTCOME_UNKNOWN",
    });
    throw actionError(
      "SUBMISSION_OUTCOME_UNKNOWN",
      "The TeamDynamix form submission outcome is unknown; inspect My Requests before taking another action",
    );
  }

  let ticketId;
  try {
    ticketId = await successfulTicketId(response, action);
  } catch (error) {
    const rejected = error.code === "TEAM_DYNAMIX_FORM_REJECTED";
    await journal.update(record, {
      state: rejected ? "submission_rejected" : "outcome_unknown",
      errorCode: error.code ?? "SUBMISSION_OUTCOME_UNKNOWN",
      upstreamStatus: response.status,
    });
    throw error;
  }

  const ticketReference = `${action.referencePrefix}-${ticketId}`;
  for (const attachment of record.attachments) {
    attachment.status = "uploaded";
  }
  const result = {
    submission_id: submissionId,
    status: "complete",
    ticket_reference: ticketReference,
    attachments: {
      requested: record.attachments.length,
      uploaded: record.attachments.length,
      failed: 0,
      items: record.attachments.map(({ name, status }) => ({
        name,
        status,
      })),
    },
  };
  await journal.update(record, {
    state: "complete",
    ticketReference,
    result,
  });
  onEvent?.("completed", {
    submissionId,
    ticketReference,
    uploaded: record.attachments.length,
    failed: 0,
  });
  return result;
}
