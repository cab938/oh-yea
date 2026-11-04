import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildExpenseFormData,
  executeTeamDynamixExpenseReport,
  freezeExpenseAttachments,
  validateExpenseFormSnapshot,
} from "../src/lib/teamdynamix-expense-action.mjs";

function definition() {
  return {
    name: "umich.teamdynamix.expense_report.submit",
    action: {
      type: "teamdynamix_expense_report",
      formUrl:
        "https://teamdynamix.example.test/TDClient/40/Portal/Requests/Service/1737/Expense/Request",
      submitUrl:
        "https://teamdynamix.example.test/TDClient/40/Portal/Requests/TicketRequests/NewForm?ID=1737&RequestorType=Service",
      confirmationUrlPrefix:
        "https://teamdynamix.example.test/TDClient/40/Portal/Requests/",
      formId: 3196,
      referencePrefix: "TDX",
      fieldMappings: {
        reimbursement_for: {
          name: "attribute15885",
          kind: "select",
          choices: { employee: "59724" },
        },
        expense_categories: {
          name: "attribute15509",
          kind: "checklist",
          choices: {
            travel: "58812",
            other: "58814",
          },
        },
        travel_start_date: {
          name: "attribute5010",
          kind: "date",
        },
        additional_comments: {
          name: "attribute138.Content",
          kind: "text",
        },
      },
      attachments: {
        fieldName: "files",
        allowedExtensions: [".pdf", ".jpg", ".jpeg", ".png"],
        maxFiles: 20,
        maxFileBytes: 1024 * 1024,
        maxTotalBytes: 2 * 1024 * 1024,
      },
    },
  };
}

function snapshot(overrides = {}) {
  return {
    found: true,
    pageUrl: definition().action.formUrl,
    actionUrl: definition().action.submitUrl,
    method: "POST",
    enctype: "multipart/form-data",
    entries: [
      ["__RequestVerificationToken", "private-token"],
      ["__RequestVerificationTokenPair", "private-token-pair"],
      ["FormID", "3196"],
      ["attribute15885", ""],
      ["attribute15509Choice58812", "false"],
      ["attribute15509Choice58814", "false"],
      ["attribute15509", ""],
      ["attribute15509Name", ""],
      ["attribute5010", ""],
      ["attribute138.Content", ""],
      ["attribute138.EditorKey", "private-editor-key"],
    ],
    controls: [
      {
        tagName: "select",
        type: "select-one",
        name: "attribute15885",
        options: [
          { value: "", label: "", selected: true },
          {
            value: "59724",
            label: "An expense for an employee",
            selected: false,
          },
        ],
      },
      {
        tagName: "input",
        type: "checkbox",
        name: "attribute15509Choice58812",
        dataValue: "58812",
        dataName: "Travel",
      },
      {
        tagName: "input",
        type: "checkbox",
        name: "attribute15509Choice58814",
        dataValue: "58814",
        dataName: "Other",
      },
      {
        tagName: "input",
        type: "hidden",
        name: "attribute15509",
      },
      {
        tagName: "input",
        type: "hidden",
        name: "attribute15509Name",
      },
      {
        tagName: "input",
        type: "text",
        name: "attribute5010",
      },
      {
        tagName: "textarea",
        type: "textarea",
        name: "attribute138.Content",
      },
      {
        tagName: "input",
        type: "file",
        name: "files",
        multiple: true,
      },
    ],
    ...overrides,
  };
}

function input(receiptPath, submissionId = "claim-1") {
  return {
    submission_id: submissionId,
    fields: {
      reimbursement_for: "employee",
      expense_categories: ["travel"],
      travel_start_date: "2026-07-26",
      additional_comments: "Prepared expense report",
    },
    attachments: [{ path: receiptPath, name: "receipt.pdf" }],
  };
}

async function temporaryExpense(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "agent-broker-expense-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const receiptPath = path.join(directory, "source.pdf");
  await fs.writeFile(receiptPath, "receipt bytes");
  return {
    directory,
    receiptPath,
    journalDirectory: path.join(directory, "journal"),
    captureDirectory: path.join(directory, "captures"),
  };
}

test("verifies the fixed TeamDynamix form before preparing a submission", () => {
  const prepared = validateExpenseFormSnapshot(
    definition().action,
    snapshot(),
  );
  assert.equal(
    prepared.mappingDetails.expense_categories.choices.travel.dataName,
    "Travel",
  );
  assert.throws(
    () =>
      validateExpenseFormSnapshot(
        definition().action,
        snapshot({ actionUrl: "https://teamdynamix.example.test/other" }),
      ),
    (error) => {
      assert.equal(error.code, "FORM_CHANGED");
      return true;
    },
  );
});

test("maps semantic fields onto the captured browser form contract", async (t) => {
  const temporary = await temporaryExpense(t);
  const action = definition().action;
  const attachments = await freezeExpenseAttachments(
    input(temporary.receiptPath),
    action,
  );
  const prepared = validateExpenseFormSnapshot(action, snapshot());
  const form = buildExpenseFormData(
    action,
    input(temporary.receiptPath),
    prepared,
    attachments,
  );

  assert.equal(form.get("__RequestVerificationToken"), "private-token");
  assert.equal(form.get("FormID"), "3196");
  assert.equal(form.get("attribute15885"), "59724");
  assert.deepEqual(form.getAll("attribute15509Choice58812"), [
    "true",
    "false",
  ]);
  assert.deepEqual(form.getAll("attribute15509Choice58814"), ["false"]);
  assert.equal(form.get("attribute15509"), "58812");
  assert.equal(form.get("attribute15509Name"), "Travel");
  assert.equal(form.get("attribute5010"), "07/26/2026");
  assert.equal(
    form.get("attribute138.Content"),
    "Prepared expense report",
  );
  assert.equal(form.get("files").name, "receipt.pdf");
});

test("submits one multipart form, records the ticket, and replays without another write", async (t) => {
  const temporary = await temporaryExpense(t);
  const calls = [];
  const snapshots = [];
  const events = [];
  const options = {
    fetch: async (url, request) => {
      calls.push({ url: String(url), request });
      return new Response(null, {
        status: 302,
        headers: {
          location:
            "/TDClient/40/Portal/Requests/TicketRequests/TicketRequestDetails?TicketID=4242",
        },
      });
    },
    formSnapshot: async (request) => {
      snapshots.push(request);
      return snapshot();
    },
    definition: definition(),
    input: input(temporary.receiptPath),
    journalDirectory: temporary.journalDirectory,
    onEvent: (phase, context) => events.push({ phase, context }),
  };

  const first = await executeTeamDynamixExpenseReport(options);
  const second = await executeTeamDynamixExpenseReport(options);

  assert.deepEqual(first, {
    submission_id: "claim-1",
    status: "complete",
    ticket_reference: "TDX-4242",
    attachments: {
      requested: 1,
      uploaded: 1,
      failed: 0,
      items: [{ name: "receipt.pdf", status: "uploaded" }],
    },
  });
  assert.deepEqual(second, first);
  assert.equal(calls.length, 1);
  assert.equal(snapshots.length, 1);
  assert.equal(calls[0].url, definition().action.submitUrl);
  assert.equal(calls[0].request.method, "POST");
  assert.equal(calls[0].request.credentials, "include");
  assert.equal(calls[0].request.redirect, "follow");
  assert.equal(calls[0].request.body instanceof FormData, true);
  assert.equal(calls[0].request.body.get("files").name, "receipt.pdf");
  assert.deepEqual(
    events.map(({ phase }) => phase),
    ["started", "completed"],
  );

  const journalPath = path.join(
    temporary.journalDirectory,
    "claim-1.json",
  );
  const journalText = await fs.readFile(journalPath, "utf8");
  const journal = JSON.parse(journalText);
  assert.equal(journal.state, "complete");
  assert.equal(journal.result.ticket_reference, "TDX-4242");
  assert.equal(journalText.includes(temporary.receiptPath), false);
  assert.equal(journalText.includes("private-token"), false);
  assert.equal((await fs.stat(journalPath)).mode & 0o777, 0o600);
});

test("recognizes a 200 TeamDynamix detail page with a marked-up service request ID", async (t) => {
  const temporary = await temporaryExpense(t);
  const result = await executeTeamDynamixExpenseReport({
    fetch: async () =>
      new Response(
        `<!doctype html>
        <h1>Travel and Expense eForm Request</h1>
        <div>Service <strong>Request</strong> ID:</div>
        <a href="/request">80808080</a>`,
        { status: 200, headers: { "content-type": "text/html" } },
      ),
    formSnapshot: async () => snapshot(),
    definition: definition(),
    input: input(temporary.receiptPath, "claim-detail-page"),
    journalDirectory: temporary.journalDirectory,
  });

  assert.equal(result.ticket_reference, "TDX-80808080");
  const journal = JSON.parse(
    await fs.readFile(
      path.join(temporary.journalDirectory, "claim-detail-page.json"),
      "utf8",
    ),
  );
  assert.equal(journal.state, "complete");
});

test("records an unrecognized HTTP response as outcome unknown, not rejected", async (t) => {
  const temporary = await temporaryExpense(t);
  await assert.rejects(
    executeTeamDynamixExpenseReport({
      fetch: async () =>
        new Response("<h1>Unexpected post-submission page</h1>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      formSnapshot: async () => snapshot(),
      definition: definition(),
      input: input(temporary.receiptPath, "claim-unrecognized"),
      journalDirectory: temporary.journalDirectory,
    }),
    (error) => {
      assert.equal(error.code, "SUBMISSION_OUTCOME_UNKNOWN");
      return true;
    },
  );
  const journal = JSON.parse(
    await fs.readFile(
      path.join(temporary.journalDirectory, "claim-unrecognized.json"),
      "utf8",
    ),
  );
  assert.equal(journal.state, "outcome_unknown");
});

test("records a returned expense form as a definite rejection", async (t) => {
  const temporary = await temporaryExpense(t);
  await assert.rejects(
    executeTeamDynamixExpenseReport({
      fetch: async () =>
        new Response('<form class="js-entry-form"></form>', {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      formSnapshot: async () => snapshot(),
      definition: definition(),
      input: input(temporary.receiptPath, "claim-rejected"),
      journalDirectory: temporary.journalDirectory,
    }),
    (error) => {
      assert.equal(error.code, "TEAM_DYNAMIX_FORM_REJECTED");
      return true;
    },
  );
  const journal = JSON.parse(
    await fs.readFile(
      path.join(temporary.journalDirectory, "claim-rejected.json"),
      "utf8",
    ),
  );
  assert.equal(journal.state, "submission_rejected");
});

test("captures a fully mapped expense rehearsal without posting or consuming the submission ID", async (t) => {
  const temporary = await temporaryExpense(t);
  const captureDefinition = definition();
  captureDefinition.name = "umich.teamdynamix.expense_report.capture";
  captureDefinition.action.type = "teamdynamix_expense_report_capture";
  let posts = 0;
  const events = [];
  const requestInput = input(
    temporary.receiptPath,
    "claim-capture-then-submit",
  );

  const captured = await executeTeamDynamixExpenseReport({
    fetch: async () => {
      posts += 1;
      throw new Error("capture must not submit");
    },
    formSnapshot: async () => snapshot(),
    definition: captureDefinition,
    input: requestInput,
    journalDirectory: temporary.journalDirectory,
    captureDirectory: temporary.captureDirectory,
    onEvent: (phase, context) => events.push({ phase, context }),
  });

  assert.equal(posts, 0);
  assert.equal(captured.status, "captured");
  assert.match(
    captured.capture_reference,
    /^CAPTURE-[0-9a-f-]{36}$/u,
  );
  assert.deepEqual(captured.attachments, {
    requested: 1,
    captured: 1,
    items: [
      {
        name: "receipt.pdf",
        status: "captured",
        media_type: "application/pdf",
        bytes: 13,
      },
    ],
  });
  assert.deepEqual(
    events.map(({ phase }) => phase),
    ["captured"],
  );

  const [artifactName] = await fs.readdir(temporary.captureDirectory);
  const artifactPath = path.join(temporary.captureDirectory, artifactName);
  const artifactText = await fs.readFile(artifactPath, "utf8");
  const artifact = JSON.parse(artifactText);
  assert.equal(artifact.capture_reference, captured.capture_reference);
  assert.equal(
    artifact.intended_request.url,
    definition().action.submitUrl,
  );
  assert.deepEqual(artifact.intended_request.anti_forgery, [
    {
      name: "__RequestVerificationToken",
      present: true,
      value: "[redacted]",
    },
    {
      name: "__RequestVerificationTokenPair",
      present: true,
      value: "[redacted]",
    },
  ]);
  assert.deepEqual(
    artifact.intended_request.fields.find(
      ({ semantic_name }) => semantic_name === "reimbursement_for",
    ),
    {
      semantic_name: "reimbursement_for",
      semantic_value: "employee",
      rendered: [{ name: "attribute15885", values: ["59724"] }],
    },
  );
  assert.equal(artifactText.includes("private-token"), false);
  assert.equal(artifactText.includes("receipt bytes"), false);
  assert.equal(artifactText.includes(temporary.receiptPath), false);
  assert.equal((await fs.stat(temporary.captureDirectory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(artifactPath)).mode & 0o777, 0o600);
  await assert.rejects(
    fs.stat(
      path.join(
        temporary.journalDirectory,
        "claim-capture-then-submit.json",
      ),
    ),
    { code: "ENOENT" },
  );

  const submitted = await executeTeamDynamixExpenseReport({
    fetch: async () => {
      posts += 1;
      return new Response(null, {
        status: 302,
        headers: {
          location:
            "/TDClient/40/Portal/Requests/TicketRequests/TicketRequestDetails?TicketID=5252",
        },
      });
    },
    formSnapshot: async () => snapshot(),
    definition: definition(),
    input: requestInput,
    journalDirectory: temporary.journalDirectory,
  });
  assert.equal(submitted.ticket_reference, "TDX-5252");
  assert.equal(posts, 1);
});

test("fails closed before journaling when the live form contract changes", async (t) => {
  const temporary = await temporaryExpense(t);
  let submitted = false;
  await assert.rejects(
    executeTeamDynamixExpenseReport({
      fetch: async () => {
        submitted = true;
        return new Response(null, { status: 302 });
      },
      formSnapshot: async () =>
        snapshot({ entries: [["FormID", "different"]] }),
      definition: definition(),
      input: input(temporary.receiptPath, "claim-form-changed"),
      journalDirectory: temporary.journalDirectory,
    }),
    (error) => {
      assert.equal(error.code, "FORM_CHANGED");
      return true;
    },
  );
  assert.equal(submitted, false);
  await assert.rejects(
    fs.stat(
      path.join(
        temporary.journalDirectory,
        "claim-form-changed.json",
      ),
    ),
    { code: "ENOENT" },
  );
});

test("records an unknown POST outcome and refuses an automatic retry", async (t) => {
  const temporary = await temporaryExpense(t);
  let calls = 0;
  const options = {
    fetch: async () => {
      calls += 1;
      throw new Error("connection lost");
    },
    formSnapshot: async () => snapshot(),
    definition: definition(),
    input: input(temporary.receiptPath, "claim-unknown"),
    journalDirectory: temporary.journalDirectory,
  };

  await assert.rejects(
    executeTeamDynamixExpenseReport(options),
    (error) => {
      assert.equal(error.code, "SUBMISSION_OUTCOME_UNKNOWN");
      return true;
    },
  );
  await assert.rejects(
    executeTeamDynamixExpenseReport(options),
    (error) => {
      assert.equal(error.code, "SUBMISSION_ALREADY_ATTEMPTED");
      return true;
    },
  );
  assert.equal(calls, 1);
  const journal = JSON.parse(
    await fs.readFile(
      path.join(temporary.journalDirectory, "claim-unknown.json"),
      "utf8",
    ),
  );
  assert.equal(journal.state, "outcome_unknown");
});

test("freezes files and rejects changed-content replay", async (t) => {
  const temporary = await temporaryExpense(t);
  const options = {
    fetch: async () =>
      new Response(null, {
        status: 302,
        headers: {
          location:
            "/TDClient/40/Portal/Requests/TicketRequests/TicketRequestDetails?TicketID=6161",
        },
      }),
    formSnapshot: async () => snapshot(),
    definition: definition(),
    input: input(temporary.receiptPath, "claim-conflict"),
    journalDirectory: temporary.journalDirectory,
  };
  await executeTeamDynamixExpenseReport(options);
  await fs.writeFile(temporary.receiptPath, "changed receipt bytes");
  await assert.rejects(
    executeTeamDynamixExpenseReport(options),
    (error) => {
      assert.equal(error.code, "SUBMISSION_CONFLICT");
      return true;
    },
  );
});

test("rejects unsupported, oversized, and symlink attachments before any form load", async (t) => {
  const temporary = await temporaryExpense(t);
  const action = definition().action;
  const textPath = path.join(temporary.directory, "receipt.txt");
  await fs.writeFile(textPath, "text");
  await assert.rejects(
    freezeExpenseAttachments(
      {
        ...input(textPath),
        attachments: [{ path: textPath, name: "receipt.txt" }],
      },
      action,
    ),
    (error) => {
      assert.equal(error.code, "UNSUPPORTED_ATTACHMENT");
      return true;
    },
  );

  const linkPath = path.join(temporary.directory, "link.pdf");
  await fs.symlink(temporary.receiptPath, linkPath);
  await assert.rejects(
    freezeExpenseAttachments(input(linkPath), action),
    (error) => {
      assert.equal(error.code, "INVALID_ATTACHMENT");
      return true;
    },
  );

  await fs.writeFile(
    temporary.receiptPath,
    Buffer.alloc(action.attachments.maxFileBytes + 1),
  );
  await assert.rejects(
    freezeExpenseAttachments(input(temporary.receiptPath), action),
    (error) => {
      assert.equal(error.code, "ATTACHMENT_LIMIT_EXCEEDED");
      return true;
    },
  );
});

test("serializes concurrent use of one submission ID before the form POST", async (t) => {
  const temporary = await temporaryExpense(t);
  let calls = 0;
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const options = {
    fetch: async () => {
      calls += 1;
      await blocked;
      return new Response(null, {
        status: 302,
        headers: {
          location:
            "/TDClient/40/Portal/Requests/TicketRequests/TicketRequestDetails?TicketID=7171",
        },
      });
    },
    formSnapshot: async () => snapshot(),
    definition: definition(),
    input: input(temporary.receiptPath, "claim-concurrent"),
    journalDirectory: temporary.journalDirectory,
  };

  const first = executeTeamDynamixExpenseReport(options);
  await new Promise((resolve) => setImmediate(resolve));
  const second = executeTeamDynamixExpenseReport(options);
  await assert.rejects(second, (error) => {
    assert.equal(error.code, "SUBMISSION_ALREADY_ATTEMPTED");
    return true;
  });
  release();
  await first;
  assert.equal(calls, 1);
});
