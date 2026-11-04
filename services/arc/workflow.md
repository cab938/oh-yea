---
id: arc
name: ARC Great Lakes
aliases: [ARC, Great Lakes, remaining compute hours]
description: Read the configured Great Lakes allocation's remaining partition hours.
---

# ARC Great Lakes

Read the adjacent `capabilities.json`, refreshed by `agent-broker services`, and invoke the enabled remaining-hours capability with its advertised input (currently an empty object).

The broker selects the configured allocation and authenticates through the human's U-M session. Do not ask for a project URL, identity headers, or credentials. Keep the same request open if it is waiting for sign-in.

Report the returned partition names and remaining hours as supplied. These are allocation balances, not job scheduling estimates, current GPU availability, elapsed usage, or a forecast. Do not infer a different allocation or combine partition balances without a user-requested interpretation.

This service currently reads balances only. It cannot submit jobs, purchase allocations, or change account settings. Report an unavailable capability or failed authentication through the broker's error response.
