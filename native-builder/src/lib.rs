#[macro_use]
extern crate napi_derive;

use napi::{Result, Error, Status};
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    system_program,
};
use std::str::FromStr;

// ─── Constants ───────────────────────────────────────────────────────────────

const PUMP_PROGRAM_ID: &str = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_SWAP_PROGRAM_ID: &str = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const GLOBAL_ACCOUNT: &str = "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf";
const WSOL_MINT: &str = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAM_ID: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM_ID: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xr25ix9aJ6VSCWNABq";
const RENT_ID: &str = "SysvarRent111111111111111111111111111111111";

// Discriminators (first 8 bytes of SHA256("global:<instruction>"))
const BUY_DISCRIMINATOR: [u8; 8] = [102, 6, 61, 18, 1, 218, 235, 234];
const SELL_DISCRIMINATOR: [u8; 8] = [23, 183, 248, 55, 96, 216, 172, 96];

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn find_pda(seeds: &[&[u8]], program_id: &Pubkey) -> Pubkey {
    let (pda, _) = Pubkey::find_program_address(seeds, program_id);
    pda
}

fn pubkey_from_str(s: &str) -> Result<Pubkey> {
    Pubkey::from_str(s).map_err(|e| {
        Error::new(Status::InvalidArg, format!("Invalid pubkey '{}': {}", s, e))
    })
}

fn get_ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    let (ata, _) = Pubkey::find_program_address(
        &[
            &owner.to_bytes(),
            &pubkey_from_str(TOKEN_PROGRAM_ID).unwrap().to_bytes(),
            &mint.to_bytes(),
        ],
        &pubkey_from_str(ASSOCIATED_TOKEN_PROGRAM_ID).unwrap(),
    );
    ata
}

// ─── Exposed napi functions ───────────────────────────────────────────────────

/// Build a Pump.fun bonding curve BUY instruction.
/// Returns the serialized instruction as a Vec<u8> (base64-encoded string for JS).
#[napi]
pub fn build_pump_buy_instruction(
    mint: String,
    user: String,
    bonding_curve: String,
    amount: String,       // token amount as decimal string (u64)
    max_sol_cost: String, // max SOL in lamports as decimal string (u64)
    sol_amount: String,   // SOL to spend in lamports (u64)
) -> Result<Vec<u8>> {
    let mint_pk = pubkey_from_str(&mint)?;
    let user_pk = pubkey_from_str(&user)?;
    let curve_pk = pubkey_from_str(&bonding_curve)?;
    let program_pk = pubkey_from_str(PUMP_PROGRAM_ID)?;
    let global_pk = pubkey_from_str(GLOBAL_ACCOUNT)?;

    let amount_u64: u64 = amount.parse().map_err(|e| Error::new(Status::InvalidArg, format!("Invalid amount: {}", e)))?;
    let max_sol_u64: u64 = max_sol_cost.parse().map_err(|e| Error::new(Status::InvalidArg, format!("Invalid max_sol: {}", e)))?;

    let fee_recipient = find_pda(&[b"fee-recipient"], &program_pk);
    let event_authority = find_pda(&[b"__event_authority"], &program_pk);
    let associated_bonding_curve = get_ata(&curve_pk, &mint_pk);
    let user_token_account = get_ata(&user_pk, &mint_pk);

    let mut data = Vec::with_capacity(24);
    data.extend_from_slice(&BUY_DISCRIMINATOR);
    data.extend_from_slice(&amount_u64.to_le_bytes());
    data.extend_from_slice(&max_sol_u64.to_le_bytes());

    let accounts = vec![
        AccountMeta::new(global_pk, false),
        AccountMeta::new(fee_recipient, false),
        AccountMeta::new_readonly(mint_pk, false),
        AccountMeta::new(curve_pk, false),
        AccountMeta::new(associated_bonding_curve, false),
        AccountMeta::new(user_token_account, false),
        AccountMeta::new(user_pk, true),
        AccountMeta::new_readonly(system_program::id(), false),
        AccountMeta::new_readonly(pubkey_from_str(TOKEN_PROGRAM_ID)?, false),
        AccountMeta::new_readonly(pubkey_from_str(RENT_ID)?, false),
        AccountMeta::new_readonly(event_authority, false),
        AccountMeta::new_readonly(program_pk, false),
    ];

    let instruction = Instruction { program_id: program_pk, accounts, data };

    bincode::serialize(&instruction).map_err(|e| {
        Error::new(Status::GenericFailure, format!("Serialization error: {}", e))
    })
}

/// Build a Pump.fun bonding curve SELL instruction.
#[napi]
pub fn build_pump_sell_instruction(
    mint: String,
    user: String,
    bonding_curve: String,
    amount: String,
    min_sol_output: String,
    cashback_enabled: bool,
) -> Result<Vec<u8>> {
    let mint_pk = pubkey_from_str(&mint)?;
    let user_pk = pubkey_from_str(&user)?;
    let curve_pk = pubkey_from_str(&bonding_curve)?;
    let program_pk = pubkey_from_str(PUMP_PROGRAM_ID)?;
    let global_pk = pubkey_from_str(GLOBAL_ACCOUNT)?;

    let amount_u64: u64 = amount.parse().map_err(|e| Error::new(Status::InvalidArg, format!("Invalid amount: {}", e)))?;
    let min_sol_u64: u64 = min_sol_output.parse().map_err(|e| Error::new(Status::InvalidArg, format!("Invalid min_sol: {}", e)))?;

    let fee_recipient = find_pda(&[b"fee-recipient"], &program_pk);
    let event_authority = find_pda(&[b"__event_authority"], &program_pk);
    let associated_bonding_curve = get_ata(&curve_pk, &mint_pk);
    let user_token_account = get_ata(&user_pk, &mint_pk);
    let creator_vault = find_pda(&[b"creator-vault", &mint_pk.to_bytes()], &program_pk);
    let bonding_curve_v2 = find_pda(&[b"bonding-curve-v2", &mint_pk.to_bytes()], &program_pk);

    let fee_config = pubkey_from_str("ETq2m4g4DNTpqqoxGqVFXFu3AqTfoPgXxzhn7qSbCjH8")?;
    let fee_program = pubkey_from_str("tFEFkijPwQCjMvKDqf4CT1L2fx5iPAYHNct3HStafat")?;

    let mut data = Vec::with_capacity(24);
    data.extend_from_slice(&SELL_DISCRIMINATOR);
    data.extend_from_slice(&amount_u64.to_le_bytes());
    data.extend_from_slice(&min_sol_u64.to_le_bytes());

    let mut accounts = vec![
        AccountMeta::new_readonly(global_pk, false),
        AccountMeta::new(fee_recipient, false),
        AccountMeta::new_readonly(mint_pk, false),
        AccountMeta::new(curve_pk, false),
        AccountMeta::new(associated_bonding_curve, false),
        AccountMeta::new(user_token_account, false),
        AccountMeta::new(user_pk, true),
        AccountMeta::new_readonly(system_program::id(), false),
        AccountMeta::new(creator_vault, false),
        AccountMeta::new_readonly(pubkey_from_str(TOKEN_PROGRAM_ID)?, false),
        AccountMeta::new_readonly(event_authority, false),
        AccountMeta::new_readonly(program_pk, false),
        AccountMeta::new_readonly(fee_config, false),
        AccountMeta::new_readonly(fee_program, false),
    ];

    if cashback_enabled {
        let user_vol = find_pda(&[b"user_volume_accumulator", &user_pk.to_bytes()], &program_pk);
        accounts.push(AccountMeta::new(user_vol, false));
    }

    // bonding_curve_v2 is ALWAYS last
    accounts.push(AccountMeta::new_readonly(bonding_curve_v2, false));

    let instruction = Instruction { program_id: program_pk, accounts, data };

    bincode::serialize(&instruction).map_err(|e| {
        Error::new(Status::GenericFailure, format!("Serialization error: {}", e))
    })
}
