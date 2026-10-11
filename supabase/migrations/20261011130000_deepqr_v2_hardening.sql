-- =============================================================================
-- DeepQr v2 — hardening (run AFTER the v2 app is live on GitHub Pages)
--
-- The old app looked up staff usernames by reading the whole username_directory
-- table, which let anyone list every username, login email and business id.
-- The v2 app uses dq_login_email(username) instead, so the open read can go.
-- Running this before the v2 app is deployed would break username sign-in on
-- the old app, so apply it last.
-- =============================================================================
drop policy if exists dir_select on public.username_directory;
create policy dir_select on public.username_directory for select to authenticated
  using (business_id = public.my_business_id());
