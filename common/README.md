# Common

Shared app contracts understood by both the React client and Supabase functions live here.

- `agoraRequestIdentifiers.ts` owns the stable v1 identifier catalog and contract version.
- `agoraDtos.ts` owns serialized request and response shapes.
- `agoraRequestContract.ts` maps every identifier to its parameter and result DTOs and defines the versioned wire envelope.

The catalog intentionally has no handlers in this foundation. Product behavior lands behind the shared contract in later issues.

Keep this folder product-specific. General-purpose utilities that could reasonably become external packages belong in `lib`.
