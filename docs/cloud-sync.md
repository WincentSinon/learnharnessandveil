# Cloud sync setup

Cloud sync keeps your saved Veil Study library available on your desktop and laptop. Each computer still saves locally. Online changes sync automatically while the app is running; offline changes wait until the connection returns.

## Connect your Supabase project

1. Create a Supabase project at [supabase.com](https://supabase.com/dashboard). The Free plan is suitable for an initial personal library within its limits.
2. In Veil Study, open **Settings → Cloud sync**. Copy the supplied setup SQL, paste it into your project's **SQL Editor**, and run it once. You can also use [the setup file](../supabase/cloud-sync.sql). Running the same script again is safe. It creates the session table, an atomic update function, account access policies, and the private `veil-pdfs` bucket.
3. In Supabase's project **Connect/API settings**, copy the **Project URL** and **publishable key**. A legacy **anon** key also works. Paste them into Cloud sync settings and save the connection. Do not use a secret or `service_role` key; the app refuses them.
4. Create a cloud email/password account using **Create account** in the app, then follow any confirmation email and sign in. Alternatively, create your own confirmed email/password user in Supabase **Authentication → Users**, then sign in from the app. Email confirmation delivery depends on your project's Auth/email configuration.
5. Turn on **Automatic sync**. This explicitly starts uploading this computer's saved study data. Wait for **Synced** before switching computers. **Sync now** requests an immediate cycle.
6. On the laptop, enter the **same Project URL and publishable key**, sign into the **same cloud account**, and enable automatic sync. You only run the SQL once per project. Open synced conversations from **Sessions** and saved PDFs from **My reading**.

The publishable key identifies your project; your account login identifies which private library you can access. Project/API configuration and sign-in sessions are stored locally, and access/refresh tokens are not exposed in the settings response or uploaded as study data. Passwords are sent to Supabase Auth for sign-in and are not saved by Veil Study.

## What is synced

- Completed study and practice conversations, lesson plans and their saved progress.
- Saved PDF copies, page/scroll position, zoom, voice preferences, rephrase drafts, and understanding-check feedback.
- Passage-to-study-session links and saved learning-graph records/source organization.

Click **Save session** for a PDF before expecting it in the cloud library. Merely opening a file does not save a reading session. Each PDF is identified by its content hash and uploaded once for the current account/project, rather than on every page change. Unchanged chat contents are not downloaded on every sync check.

Provider API keys, provider login credentials, downloaded neural voices, caches, window settings and debug logs stay on each computer. Configure your AI provider and install voices separately on the laptop. Arbitrary files referenced by local paths inside conversations or imported-source metadata are **not** uploaded; copy those files separately if a task needs them on another computer.

## Offline, conflicts and deletion

- Local saves continue without internet. **Offline** or an error means some changes have not reached the cloud yet. Leave the app open after reconnecting and check for **Synced**.
- Avoid editing the same conversation on both computers simultaneously. The sync service checks record revisions before writing. Conflicting chat/reading changes are preserved as separate **conflict copies**, rather than silently erased. Other conflicting metadata is retained as recovery records in the local data directory's `sync-conflicts` folder; there is no graphical merge editor yet.
- A conversation with an active local AI turn is deferred until the turn finishes. Sync transfers saved state; it does not continue AI computation after the app is fully closed.
- Deleting a previously synced record propagates its deletion. Turning off sync or signing out pauses sync and leaves your local library intact; it does not erase cloud data. Unreferenced PDF files are retained in the bucket so another saved session cannot lose its shared document.
- The local library remains on the device after changing accounts/projects. Enabling another account/project uploads that existing local library to the newly selected destination.

## Free-plan limits and first check

Supabase Free currently includes **500 MB database storage, 1 GB file storage and a 50 MB maximum individual file upload**. A larger PDF remains local and produces an actionable sync error; it is not falsely marked synced. Larger storage needs may require a different plan. See [Supabase pricing](https://supabase.com/pricing) and [upload limits](https://supabase.com/docs/guides/storage/uploads/file-limits). Free projects may pause after a week of inactivity and need to be resumed in the Supabase dashboard.

For a first check, save a small PDF and study conversation on the desktop, wait for **Synced**, then open the laptop and confirm both appear. Change the saved page on the laptop, allow it to sync, and resume that session from **My reading** on the desktop. An already-open reader keeps its current workspace; resume the saved entry to load a position received from another device.

## Official references

- [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys)
- [Row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Private storage access](https://supabase.com/docs/guides/storage/security/access-control)
- [Authenticated downloads](https://supabase.com/docs/guides/storage/serving/downloads)
