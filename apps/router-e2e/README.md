The e2e runner for Expo Router and Metro web.

## Contributing

The runnable projects are located in the `__e2e__` directory. We use scripts in the package.json to configure the environment using environment variables such as `E2E_ROUTER_SRC=01-rsc` where `01-rsc` is the sub-directory in `__e2e__` containing an Expo Router routes directory named `app`.

### E2E Tests

To run the E2E tests, navigate to `packages/@expo/cli` and run `pnpm test:e2e <NAME_OF_RUNNABLE_PROJECT>`, or `pnpm test:playwright <NAME_OF_RUNNABLE_PROJECT>`

### Native

- Run `pnpm prebuild` to create the ios and android directories using the latest `expo-template-bare-minimum` template.
- Run `npx expo run:ios` and `npx expo run:android` to build the native projects.
- For production, use `npx expo run:ios --configuration Release` and `npx expo run:android --variant release`.
- Optional: Create a `.env.local` file with your Apple Team ID. `touch .env.local && echo "APPLE_TEAM_ID=YOUR_TEAM_ID" >> .env.local`.

### Web

- Start any project and open it in a web browser, e.g. `pnpm start:01-rsc`.
- For production, use an export script like `pnpm export:web-workers` and then serve it with `npx expo serve`.

### Experimental BitSet chunking

From this directory:

```sh
pnpm export:bitset
pnpm exec expo serve dist-bitset
```

Open the printed URL, then try `/links` and its About link. The `static-rendering-bitset` fixture selection reuses the `static-rendering` routes and enables the normal `expo-router` plugin option `unstable_chunking: true`. No serializer-only test flag is needed. The default `static-rendering` fixture keeps legacy chunking.

Run the browser regression from the repository root:

```sh
pnpm --dir packages/@expo/cli test:playwright prod/server-rendering-async.test.ts --workers=1 --reporter=line
```

This runs legacy and opted-in exports, checks HTML-loaded chunk readiness without duplicate script requests, and verifies navigation when the target route is registered before a delayed shared dependency. The existing `static-splitting` and `server-rendering-async` CLI export suites also exercise both strategies.

The experiment currently applies only to production, non-RSC web app splitting. DOM, native, development, server bundles, and split-disabled exports retain legacy behavior. Exports containing ordinary dynamic imports inside workers also fall back to legacy; worker-local splitting is not added by this experiment.
