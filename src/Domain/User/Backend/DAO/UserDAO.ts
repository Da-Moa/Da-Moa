import 'server-only'

export type SignInUserRow = { id: string; deleted_at: string | number | null; onboarding_completed_at: string | number | null }
export type UserRow = SignInUserRow & {
  display_name: string | null; email: string | null; profile_image_url: string | null;
  bank_name: string | null; account_number: string | null; account_number_formatted: string | null;
  account_holder: string | null; bank_code: string | null; bank_verified_at: string | number | null;
  bank_version: string | number;
}
