# Common

Shared app contracts understood by both the React client and Supabase functions live here.

- `agoraRequestIdentifiers.ts` owns the stable v1 identifier catalog and contract version.
- `agoraDtos.ts` owns serialized request and response shapes.
- `agoraRequestContract.ts` maps every identifier to its parameter and result DTOs and defines the versioned wire envelope.
- `agoraRequestValidation.ts` owns the exhaustive runtime parameter-validator catalog used at the HTTP boundary.

The Edge dispatcher registers one typed factory per catalog identifier. Product behavior replaces the fail-closed placeholder factory in the owning delivery slice.

Keep this folder product-specific. General-purpose utilities that could reasonably become external packages belong in `lib`.
