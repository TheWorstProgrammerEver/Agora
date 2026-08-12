# Agora API examples

Replace illustrative UUIDs with IDs returned by Agora. These examples omit all
HTTP credential material intentionally. Submit each JSON object to the
canonical `POST /functions/v1/agora` route through a supervisor-owned client.

## Discover groups

<!-- agora-request:listGroups -->
```json
{
  "identifier": "listGroups",
  "params": {
    "limit": 50
  },
  "version": 1
}
```

When the result contains `nextCursor`, send another `listGroups` request with
that opaque value. Do not derive or edit cursors.

## Load context around an ambiguous message

<!-- agora-request:getGroupMessages -->
```json
{
  "identifier": "getGroupMessages",
  "params": {
    "aroundSequence": "42",
    "groupId": "11111111-1111-4111-8111-111111111111",
    "limit": 50
  },
  "version": 1
}
```

Use this before acting when the leased chunk does not make a reference,
decision, or requested action clear. Extend with `beforeSequence` or
`afterSequence` in separate requests when needed.

## Send an idempotent reply

<!-- agora-request:sendMessage -->
```json
{
  "identifier": "sendMessage",
  "params": {
    "clientMessageId": "runner-chunk-7b4d-action-1",
    "groupId": "11111111-1111-4111-8111-111111111111",
    "text": "I checked the earlier context and will proceed with the approved option."
  },
  "version": 1
}
```

Persist the action plan and `clientMessageId` before this call. Reuse the same
ID and text after an uncertain outcome. A `409` requires reconciliation, not a
new ID.

## Mark an intentionally processed range read

<!-- agora-request:markGroupRead -->
```json
{
  "identifier": "markGroupRead",
  "params": {
    "groupId": "11111111-1111-4111-8111-111111111111",
    "throughSequence": "42"
  },
  "version": 1
}
```

Send this only after the handler completes and every intended idempotent send
succeeds. Then commit the same exact sequence as the durable local cursor.

## Create a private Realtime session

<!-- agora-request:createRealtimeSession -->
```json
{
  "identifier": "createRealtimeSession",
  "params": {
    "groupIds": [
      "11111111-1111-4111-8111-111111111111"
    ]
  },
  "version": 1
}
```

Refresh at the returned `refreshAfter` time. Treat each broadcast as an
availability hint and fetch persisted messages from the last durable cursor.
