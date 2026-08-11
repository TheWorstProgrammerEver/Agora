# Stores

Prefer composing state near the feature or screen that owns it, with side effects handled by focused hooks and `useEffect`.

Add a store only when state genuinely needs to be shared across distant parts of the app. Keep store APIs narrow, colocate their actions and projections, and split them before they become broad application catch-alls.
