-- ============================================================
-- CHUCKLEPAD V1 DATABASE
-- ============================================================

create extension if not exists pgcrypto;


-- ============================================================
-- PROFILES
-- ============================================================

create table if not exists public.profiles (
    id uuid primary key references auth.users(id) on delete cascade,

    first_name text not null,
    last_name text not null,

    username text not null unique,

    country text not null,

    display_name text,

    referral_code text not null unique,

    referred_by uuid references public.profiles(id),

    points bigint not null default 0
        check (points >= 0),

    tickets bigint not null default 0
        check (tickets >= 0),

    streak_days integer not null default 0
        check (streak_days >= 0),

    last_signin_date date,

    genesis_eligible boolean not null default false,

    created_at timestamptz not null default now(),

    updated_at timestamptz not null default now()
);


create index if not exists profiles_username_idx
on public.profiles(username);

create index if not exists profiles_referral_code_idx
on public.profiles(referral_code);

create index if not exists profiles_points_idx
on public.profiles(points desc);

create index if not exists profiles_tickets_idx
on public.profiles(tickets desc);


-- ============================================================
-- POINTS LEDGER
-- ============================================================

create table if not exists public.points_ledger (
    id bigint generated always as identity primary key,

    user_id uuid not null references public.profiles(id)
        on delete cascade,

    amount bigint not null,

    reward_type text not null,

    reference_id text,

    description text,

    created_at timestamptz not null default now()
);


create index if not exists points_ledger_user_idx
on public.points_ledger(user_id, created_at desc);


-- ============================================================
-- REFERRALS
-- ============================================================

create table if not exists public.referrals (
    id bigint generated always as identity primary key,

    referrer_id uuid not null references public.profiles(id)
        on delete cascade,

    referred_id uuid not null unique references public.profiles(id)
        on delete cascade,

    referrer_reward bigint not null default 1000,

    referred_reward bigint not null default 1000,

    created_at timestamptz not null default now(),

    check (referrer_id <> referred_id)
);


create index if not exists referrals_referrer_idx
on public.referrals(referrer_id);


-- ============================================================
-- GENESIS CLAIMS
-- FIRST 1,000 ELIGIBLE USERS
-- ============================================================

create table if not exists public.genesis_claims (
    id bigint generated always as identity primary key,

    user_id uuid not null unique references public.profiles(id)
        on delete cascade,

    position integer not null unique
        check (position between 1 and 1000),

    code text not null default '0000000',

    reward bigint not null default 10000,

    created_at timestamptz not null default now()
);


-- ============================================================
-- DAILY SIGN-INS
-- ============================================================

create table if not exists public.daily_signins (
    id bigint generated always as identity primary key,

    user_id uuid not null references public.profiles(id)
        on delete cascade,

    signin_date date not null,

    points_awarded bigint not null default 100,

    created_at timestamptz not null default now(),

    unique(user_id, signin_date)
);


-- ============================================================
-- DAILY HUNTS
-- ============================================================

create table if not exists public.daily_hunts (
    id uuid primary key default gen_random_uuid(),

    hunt_date date not null unique,

    question text not null,

    supporting_link_required boolean not null default false,

    active boolean not null default true,

    created_at timestamptz not null default now()
);


-- ============================================================
-- HUNT SUBMISSIONS
-- ============================================================

create table if not exists public.hunt_submissions (
    id uuid primary key default gen_random_uuid(),

    hunt_id uuid not null references public.daily_hunts(id)
        on delete cascade,

    user_id uuid not null references public.profiles(id)
        on delete cascade,

    answer text not null,

    supporting_link text,

    ai_score integer
        check (ai_score between 0 and 100),

    ai_reasoning text,

    tickets_awarded integer not null default 0,

    points_awarded integer not null default 0,

    validation_status text not null default 'pending',

    submitted_at timestamptz not null default now(),

    evaluated_at timestamptz,

    unique(hunt_id, user_id)
);


-- ============================================================
-- ROCKET RUSH
-- ============================================================

create table if not exists public.rocket_attempts (
    id uuid primary key default gen_random_uuid(),

    user_id uuid not null references public.profiles(id)
        on delete cascade,

    attempt_number integer not null,

    attempt_date date not null,

    client_seed text not null,

    server_seed_hash text not null,

    server_seed text,

    nonce bigint not null,

    flight_time numeric(8,3),

    crash_time numeric(8,3),

    points_awarded integer not null default 0,

    status text not null default 'created',

    started_at timestamptz,

    finished_at timestamptz,

    created_at timestamptz not null default now(),

    unique(user_id, attempt_date, attempt_number)
);


-- ============================================================
-- WEEKLY HEIST
-- ============================================================

create table if not exists public.weekly_heists (
    id uuid primary key default gen_random_uuid(),

    week_start date not null unique,

    week_end date not null,

    prize_pool bigint not null default 1000000,

    status text not null default 'open',

    created_at timestamptz not null default now(),

    closed_at timestamptz
);


-- ============================================================
-- HEIST RESULTS
-- ============================================================

create table if not exists public.heist_results (
    id bigint generated always as identity primary key,

    heist_id uuid not null references public.weekly_heists(id)
        on delete cascade,

    user_id uuid not null references public.profiles(id)
        on delete cascade,

    rank integer not null,

    tickets bigint not null,

    points_awarded bigint not null default 0,

    created_at timestamptz not null default now(),

    unique(heist_id, user_id),

    unique(heist_id, rank)
);


-- ============================================================
-- REFERRAL CODE GENERATOR
-- ============================================================

create or replace function public.generate_referral_code()
returns text
language plpgsql
security definer
as $$
declare
    new_code text;
begin

    loop

        new_code := upper(
            substr(
                encode(gen_random_bytes(6), 'hex'),
                1,
                8
            )
        );

        exit when not exists (
            select 1
            from public.profiles
            where referral_code = new_code
        );

    end loop;

    return new_code;

end;
$$;


-- ============================================================
-- COMPLETE REGISTRATION REWARD PROCESS
--
-- This function:
--
-- 1. Creates the profile
-- 2. Gives +500 registration Points
-- 3. Checks Genesis
-- 4. Gives +10,000 Genesis Points when eligible
-- 5. Processes referral
-- 6. Gives +1,000 to referrer
-- 7. Gives +1,000 to referred user
--
-- The Genesis section uses an advisory transaction lock so that
-- simultaneous registrations cannot exceed 1,000.
-- ============================================================

create or replace function public.complete_registration(
    p_user_id uuid,
    p_first_name text,
    p_last_name text,
    p_username text,
    p_country text,
    p_referral_code text default null,
    p_genesis_code text default null
)
returns jsonb
language plpgsql
security definer
as $$
declare

    v_referrer_id uuid;

    v_new_referral_code text;

    v_genesis_position integer;

    v_genesis_awarded boolean := false;

    v_referral_awarded boolean := false;

    v_total_points bigint := 500;

begin

    -- --------------------------------------------------------
    -- Basic validation
    -- --------------------------------------------------------

    if p_user_id is null then
        raise exception 'Invalid user account.';
    end if;

    if length(trim(p_first_name)) < 2 then
        raise exception 'First name is too short.';
    end if;

    if length(trim(p_last_name)) < 2 then
        raise exception 'Last name is too short.';
    end if;

    if length(trim(p_username)) < 3 then
        raise exception 'Username must contain at least 3 characters.';
    end if;

    if length(trim(p_username)) > 30 then
        raise exception 'Username cannot exceed 30 characters.';
    end if;

    if trim(p_country) = '' then
        raise exception 'Country is required.';
    end if;


    -- --------------------------------------------------------
    -- Prevent duplicate profile
    -- --------------------------------------------------------

    if exists (
        select 1
        from public.profiles
        where id = p_user_id
    ) then

        raise exception 'Profile already exists.';

    end if;


    -- --------------------------------------------------------
    -- Username validation
    -- --------------------------------------------------------

    if p_username !~ '^[A-Za-z0-9_]+$' then

        raise exception
            'Username may contain only letters, numbers and underscores.';

    end if;


    if exists (
        select 1
        from public.profiles
        where lower(username) = lower(trim(p_username))
    ) then

        raise exception 'Username is already taken.';

    end if;


    -- --------------------------------------------------------
    -- Generate unique referral code
    -- --------------------------------------------------------

    v_new_referral_code :=
        public.generate_referral_code();


    -- --------------------------------------------------------
    -- Find referrer
    -- --------------------------------------------------------

    if p_referral_code is not null
       and trim(p_referral_code) <> '' then

        select id
        into v_referrer_id
        from public.profiles
        where upper(referral_code) =
              upper(trim(p_referral_code))
        limit 1;

        if v_referrer_id = p_user_id then
            raise exception 'You cannot refer yourself.';
        end if;

    end if;


    -- --------------------------------------------------------
    -- Create profile
    -- --------------------------------------------------------

    insert into public.profiles (
        id,
        first_name,
        last_name,
        username,
        country,
        referral_code,
        referred_by
    )
    values (
        p_user_id,
        trim(p_first_name),
        trim(p_last_name),
        trim(p_username),
        trim(p_country),
        v_new_referral_code,
        v_referrer_id
    );


    -- --------------------------------------------------------
    -- Registration reward
    -- --------------------------------------------------------

    insert into public.points_ledger (
        user_id,
        amount,
        reward_type,
        description
    )
    values (
        p_user_id,
        500,
        'registration',
        'Registration reward'
    );


    -- --------------------------------------------------------
    -- Genesis
    -- --------------------------------------------------------

    if p_genesis_code = '0000000' then

        perform pg_advisory_xact_lock(738291);

        select count(*)
        into v_genesis_position
        from public.genesis_claims;

        if v_genesis_position < 1000 then

            v_genesis_position :=
                v_genesis_position + 1;

            insert into public.genesis_claims (
                user_id,
                position,
                code,
                reward
            )
            values (
                p_user_id,
                v_genesis_position,
                '0000000',
                10000
            );

            update public.profiles
            set genesis_eligible = true
            where id = p_user_id;

            insert into public.points_ledger (
                user_id,
                amount,
                reward_type,
                description
            )
            values (
                p_user_id,
                10000,
                'genesis',
                'Genesis participant reward'
            );

            v_total_points :=
                v_total_points + 10000;

            v_genesis_awarded := true;

        end if;

    end if;


    -- --------------------------------------------------------
    -- Referral rewards
    -- --------------------------------------------------------

    if v_referrer_id is not null then

        insert into public.referrals (
            referrer_id,
            referred_id,
            referrer_reward,
            referred_reward
        )
        values (
            v_referrer_id,
            p_user_id,
            1000,
            1000
        );

        -- New user's reward

        insert into public.points_ledger (
            user_id,
            amount,
            reward_type,
            description
        )
        values (
            p_user_id,
            1000,
            'referral_signup',
            'Referral signup reward'
        );

        -- Referrer's reward

        insert into public.points_ledger (
            user_id,
            amount,
            reward_type,
            description
        )
        values (
            v_referrer_id,
            1000,
            'referral',
            'Successful referral reward'
        );

        update public.profiles
        set points = points + 1000
        where id = v_referrer_id;

        v_total_points :=
            v_total_points + 1000;

        v_referral_awarded := true;

    end if;


    -- --------------------------------------------------------
    -- Update new user's total
    -- --------------------------------------------------------

    update public.profiles
    set points = v_total_points
    where id = p_user_id;


    -- --------------------------------------------------------
    -- Return result
    -- --------------------------------------------------------

    return jsonb_build_object(
        'success', true,
        'user_id', p_user_id,
        'referral_code', v_new_referral_code,
        'points', v_total_points,
        'genesis_awarded', v_genesis_awarded,
        'genesis_position', v_genesis_position,
        'referral_awarded', v_referral_awarded
    );

end;
$$;


-- ============================================================
-- DAILY SIGN-IN
-- ============================================================

create or replace function public.claim_daily_signin(
    p_user_id uuid
)
returns jsonb
language plpgsql
security definer
as $$
declare

    today_date date := current_date;

    previous_date date;

    new_streak integer;

    streak_bonus bigint := 0;

begin

    select
        last_signin_date,
        streak_days
    into
        previous_date,
        new_streak
    from public.profiles
    where id = p_user_id
    for update;


    if previous_date = today_date then

        return jsonb_build_object(
            'success', false,
            'reason', 'already_claimed'
        );

    end if;


    if previous_date = today_date - 1 then

        new_streak :=
            coalesce(new_streak, 0) + 1;

    else

        new_streak := 1;

    end if;


    if new_streak = 30 then
        streak_bonus := 50000;
    end if;


    insert into public.daily_signins (
        user_id,
        signin_date,
        points_awarded
    )
    values (
        p_user_id,
        today_date,
        100
    );


    insert into public.points_ledger (
        user_id,
        amount,
        reward_type,
        description
    )
    values (
        p_user_id,
        100,
        'daily_signin',
        'Daily Sign-In'
    );


    if streak_bonus > 0 then

        insert into public.points_ledger (
            user_id,
            amount,
            reward_type,
            description
        )
        values (
            p_user_id,
            streak_bonus,
            'streak_bonus',
            '30-Day Streak Bonus'
        );

    end if;


    update public.profiles
    set
        points = points + 100 + streak_bonus,
        streak_days = new_streak,
        last_signin_date = today_date
    where id = p_user_id;


    return jsonb_build_object(
        'success', true,
        'daily_points', 100,
        'streak', new_streak,
        'streak_bonus', streak_bonus,
        'total_awarded', 100 + streak_bonus
    );

end;
$$;


-- ============================================================
-- LEADERBOARD
-- ============================================================

create or replace view public.leaderboard as

select
    row_number() over (
        order by points desc, created_at asc
    ) as rank,

    id,

    username,

    display_name,

    points,

    tickets,

    streak_days

from public.profiles;


-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

alter table public.profiles enable row level security;
alter table public.points_ledger enable row level security;
alter table public.referrals enable row level security;
alter table public.genesis_claims enable row level security;
alter table public.daily_signins enable row level security;
alter table public.daily_hunts enable row level security;
alter table public.hunt_submissions enable row level security;
alter table public.rocket_attempts enable row level security;
alter table public.weekly_heists enable row level security;
alter table public.heist_results enable row level security;
