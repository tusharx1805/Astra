\set ON_ERROR_STOP 0
\echo '== signup creates profile'
insert into auth.users (id,email,raw_user_meta_data) values ('11111111-1111-1111-1111-111111111111','ada@x.com','{"username":"Ada_L","full_name":"Ada Lovelace"}');
insert into auth.users (id,email,raw_user_meta_data) values ('22222222-2222-2222-2222-222222222222','ben@x.com','{"username":"ben","full_name":"Ben"}');
select id, username, full_name from public.profiles order by username;
\echo '== duplicate username rejected (whole signup rolls back)'
insert into auth.users (email,raw_user_meta_data) values ('dup@x.com','{"username":"ada_l","full_name":"Dup"}');
select count(*) as users_with_dup_email from auth.users where email='dup@x.com';
\echo '== invalid username rejected'
insert into auth.users (email,raw_user_meta_data) values ('bad@x.com','{"username":"a!","full_name":"Bad"}');
\echo '== username_available (anon)'
set role anon;
select public.username_available('ada_l') as ada_taken_should_be_false, public.username_available('new_user') as new_should_be_true, public.username_available('x') as short_should_be_false;
\echo '== anon cannot read profiles'
select count(*) from public.profiles;
reset role;
\echo '== as Ada (authenticated)'
set role authenticated;
select set_config('request.jwt.claims','{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}',false) \g /dev/null
select count(*) as readable_profiles from public.profiles;
update public.profiles set full_name='Ada K. Lovelace' where id='11111111-1111-1111-1111-111111111111';
\echo '-- update another user (expect UPDATE 0)'
update public.profiles set full_name='hacked' where id='22222222-2222-2222-2222-222222222222';
\echo '-- change own id (expect permission denied)'
update public.profiles set id='33333333-3333-3333-3333-333333333333' where id='11111111-1111-1111-1111-111111111111';
\echo '-- insert profile directly (expect permission denied)'
insert into public.profiles (id,username,full_name) values ('11111111-1111-1111-1111-111111111111','zz','zz');
\echo '-- delete own profile (expect permission denied)'
delete from public.profiles where id='11111111-1111-1111-1111-111111111111';
\echo '-- read credentials table (expect permission denied)'
select * from auth.users;
\echo '-- take Ben''s username (expect unique violation)'
update public.profiles set username='ben' where id='11111111-1111-1111-1111-111111111111';
reset role;
select username, full_name, updated_at > created_at as updated_at_bumped from public.profiles order by username;
\echo '== cascade delete'
delete from auth.users where id='22222222-2222-2222-2222-222222222222';
select count(*) as profiles_left from public.profiles;
