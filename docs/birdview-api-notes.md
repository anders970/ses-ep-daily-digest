# Birdview (EasyProjects) API v2 — reference notes

`birdview-openapi-v2.json` in this folder is the OpenAPI 3.0 spec for SES's
Birdview instance (`https://ses.go.easyprojects.net`, "Birdview PSA API v2"),
exported 2026-09-29. It is reference material only — not pushed to Apps
Script (`.claspignore` whitelists `*.gs` + `appsscript.json`).

These notes summarize what the spec says about the endpoints this project
uses or plans to use. Anything marked **unverified** has not yet been
exercised against the live instance.

## Auth

OAuth2, either Implicit or Authorization Code grant (we use Authorization
Code via the Apps Script OAuth2 library). Authorize:
`/OAuth2/Authorize`, token: `/OAuth2/Token`. OAuth clients are managed at
`/integrations/oauthclients`. Every call acts as the user who authorized the
token — which is what makes "changes made by the actual PM" possible (each
PM authorizes their own token).

## Read endpoints in use today

| Endpoint | Used for |
|---|---|
| `GET /api/v2/projects` | open Flat Fee projects (`StatusIds`, `BillingType`) |
| `GET /api/v2/customfields` | "SES PM" (`ProjectInt2`) value list |
| `GET /api/v2/users` | internal hourly rates (`HourlyRateInternal`) |
| `GET /api/v2/tasks` | tasks per project |
| `GET /api/v2/tasks/assignees` | `PersonalHoursLeft` per assignee (ETC cost) |
| `GET /api/v2/timelogs` | actual hours / labour cost |
| `GET /api/v2/expenses` | planned expenses (`IsPlanned`) |

## Write endpoints relevant to the planned "update flagged tasks" page

### Task end date — `PUT /api/v2/tasks/{id}` (body: `TaskUpdateModel`)
- **PUT only, no PATCH** for tasks: "Changes all properties of the specified
  task." So updates must be read-modify-write: `GET /api/v2/tasks/{id}`,
  change `EndDate`, send the full model back. Never send a partial body.
- Spec note: "Starting from version 3, if a NULL value is passed, it will be
  applied as the new value." We're on v2, but sending every field with its
  current value avoids depending on that.
- `TaskUpdateModel` fields: `TaskId, Name, Description, Progress,
  TaskStatusId, PriorityId, CategoryId, TaskTypeId, StartDate, EndDate,
  ActualCompletionDate, EstimatedHours, HoursLeft, Duration, DurationHours,
  IsMilestone, Billed, BillingType, BillingAmount, Budget, RateCardId,
  CustomFields`.
- Optional query param `CloseParent` (boolean). **Unverified** what it does
  beyond the name — leave unset.
- **Unverified:** whether changing `EndDate` alone also shifts `StartDate` /
  `Duration`, and how `Description` (stored as HTML) round-trips.

### Hours left — `PUT /api/v2/tasks/assignees/{id}` (body: `TaskAssigneeModel`)
- Hours left live **per assignee** as `PersonalHoursLeft` (also
  `PersonalEstimatedHours`, `WorkIsDone`). The Expected Profit % ETC cost
  uses `PersonalHoursLeft × HourlyRateInternal`, so resetting hours left
  should be done per assignee through this endpoint, not via the task-level
  `HoursLeft` field.
- `{id}` is the `TaskAssigneeId` (from `GET /api/v2/tasks/assignees` or
  `GET /api/v2/tasks/{taskId}/assignees`).
- Alternative: `PUT /api/v2/tasks/{taskId}/assignees` replaces the whole
  assignee set for a task (`SetTaskAssigneesRequest`) — riskier; avoid.
- **Unverified:** how task-level `HoursLeft` is derived from the assignees
  after an update (expected: sum of `PersonalHoursLeft`).

### Audit note on the task — `POST /api/v2/tasks/{id}/messages`
Body `NewMessageModel`: `MessageText, PostDate, Approvers, Attachments`.
Could be used to leave a visible note in Birdview for each change (e.g.
"End date 2026-09-01 → 2026-10-15 via weekly digest page"). Posted as the
PM, since it uses their token.

### Identifying the signed-in PM in Birdview
There is no "current user" endpoint. `GET /api/v2/users` returns
`UserModel` with `EMail`, so a signed-in Google account can be matched to a
Birdview `UserId` by email (assumes SES Google emails == Birdview emails —
**unverified**).
