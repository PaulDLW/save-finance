import {
  AddressLookupTableAccount,
  BlockhashWithExpiryBlockHeight,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  getMinimumBalanceForRentExemptAccount,
  createCloseAccountInstruction,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import BN from "bn.js";
import BigNumber from "bignumber.js";
import { InstructionWithEphemeralSigners, PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import {
  Obligation,
  OBLIGATION_SIZE,
  parseObligation,
} from "../state/obligation";
import { parseReserve } from "../state/reserve";
import {
  depositReserveLiquidityAndObligationCollateralInstruction,
  depositReserveLiquidityInstruction,
  redeemReserveCollateralInstruction,
  repayObligationLiquidityInstruction,
  withdrawObligationCollateralAndRedeemReserveLiquidity,
  refreshReserveInstruction,
  initObligationInstruction,
  borrowObligationLiquidityInstruction,
  refreshObligationInstruction,
  syncNative,
  depositObligationCollateralInstruction,
  withdrawObligationCollateralInstruction,
  forgiveDebtInstruction,
  repayMaxObligationLiquidityInstruction,
  depositMaxReserveLiquidityAndObligationCollateralInstruction,
  withdrawExact,
  liquidateObligationAndRedeemReserveCollateral,
} from "../instructions";
import { NULL_ORACLE, POSITION_LIMIT } from "./constants";
import { EnvironmentType, PoolType, ReserveType } from "./types";
import { getProgramId, U64_MAX, WAD } from "./constants";
import { PriceServiceConnection } from "@pythnetwork/price-service-client";
import { AnchorProvider, Program } from "@coral-xyz/anchor-30";
import {
  CrossbarClient,
  loadLookupTables,
  PullFeed,
  SB_ON_DEMAND_PID,
} from "@switchboard-xyz/on-demand";
import { Wallet } from "@coral-xyz/anchor";
import {
  createDepositAndMintWrapperTokensInstruction,
  createWithdrawAndBurnWrapperTokensInstruction,
} from "@solendprotocol/token2022-wrapper-sdk";

const SOL_PADDING_FOR_INTEREST = "1000000";

type SupportType =
  | "wrap"
  | "unwrap"
  | "refreshReserves"
  | "refreshObligation"
  | "createObligation"
  | "cAta"
  | "ata"
  | "wrapUnwrapLiquidate"
  | "wsol";

const ACTION_SUPPORT_REQUIREMENTS: {
  [Property in ActionType]: Array<SupportType>;
} = {
  deposit: ["wsol", "wrap", "createObligation", "cAta"],
  borrow: ["wsol", "ata", "refreshReserves", "refreshObligation", "unwrap"],
  withdraw: [
    "wsol",
    "ata",
    "cAta",
    "refreshReserves",
    "refreshObligation",
    "unwrap",
  ],
  repay: ["wsol", "wrap"],
  mint: ["wsol", "wrap", "cAta"],
  redeem: ["wsol", "ata", "refreshReserves", "refreshObligation", "unwrap"],
  depositCollateral: ["createObligation"],
  withdrawCollateral: ["cAta", "refreshReserves", "refreshObligation"],
  forgive: [],
  liquidate: [
    "wsol",
    "ata",
    "cAta",
    "wrapUnwrapLiquidate",
    "refreshReserves",
    "refreshObligation",
  ],
};

export const toHexString = (byteArray: number[]) => {
  return (
    "0x" +
    Array.from(byteArray, function (byte) {
      return byte.toString(16).padStart(2, "0");
    }).join("")
  );
};

export type ActionType =
  | "deposit"
  | "borrow"
  | "withdraw"
  | "repay"
  | "mint"
  | "redeem"
  | "depositCollateral"
  | "withdrawCollateral"
  | "forgive"
  | "liquidate";

export class SolendActionCore {
  programId: PublicKey;

  connection: Connection;

  reserve: ReserveType;

  pool: PoolType;

  publicKey: PublicKey;

  obligationAddress: PublicKey;

  obligationAccountInfo: Obligation | null;

  userTokenAccountAddress: PublicKey;

  userCollateralAccountAddress: PublicKey;

  seed: string;

  positions?: number;

  amount: BN;

  hostAta?: PublicKey;

  lendingIxs: Array<InstructionWithEphemeralSigners>;

  preIxs: Array<InstructionWithEphemeralSigners>;

  postIxs: Array<InstructionWithEphemeralSigners>;

  depositReserves: Array<PublicKey>;

  borrowReserves: Array<PublicKey>;

  lookupTableAccount?: AddressLookupTableAccount;

  jitoTipAmount: number;

  wallet: Wallet;

  userRepayTokenAccountAddress?: PublicKey;

  userRepayCollateralAccountAddress?: PublicKey;

  token2022Mint?: PublicKey;

  wrappedAta?: PublicKey;

  private constructor(
    programId: PublicKey,
    connection: Connection,
    reserve: ReserveType,
    pool: PoolType,
    wallet: Wallet,
    obligationAddress: PublicKey,
    obligationAccountInfo: Obligation | null,
    userTokenAccountAddress: PublicKey,
    userCollateralAccountAddress: PublicKey,
    seed: string,
    positions: number,
    amount: BN,
    depositReserves: Array<PublicKey>,
    borrowReserves: Array<PublicKey>,
    hostAta?: PublicKey,
    lookupTableAccount?: AddressLookupTableAccount,
    tipAmount?: number,
    userRepayTokenAccountAddress?: PublicKey,
    userRepayCollateralAccountAddress?: PublicKey,
    token2022Mint?: PublicKey,
    wrappedAta?: PublicKey
  ) {
    this.programId = programId;
    this.connection = connection;
    this.publicKey = wallet.publicKey;
    this.amount = new BN(amount);
    this.positions = positions;
    this.hostAta = hostAta;
    this.obligationAccountInfo = obligationAccountInfo;
    this.pool = pool;
    this.seed = seed;
    this.reserve = reserve;
    this.obligationAddress = obligationAddress;
    this.userTokenAccountAddress = userTokenAccountAddress;
    this.userCollateralAccountAddress = userCollateralAccountAddress;
    this.preIxs = [];
    this.postIxs = [];
    this.lendingIxs = [];
    this.depositReserves = depositReserves;
    this.borrowReserves = borrowReserves;
    this.lookupTableAccount = lookupTableAccount;
    this.jitoTipAmount = tipAmount ?? 1000;
    this.wallet = wallet;
    this.userRepayTokenAccountAddress = userRepayTokenAccountAddress;
    this.userRepayCollateralAccountAddress = userRepayCollateralAccountAddress;
    this.token2022Mint = token2022Mint;
    this.wrappedAta = wrappedAta;
  }

  static async initialize(
    pool: PoolType,
    reserve: ReserveType,
    action: ActionType,
    amount: BN,
    wallet: Wallet,
    connection: Connection,
    environment: EnvironmentType = "production",
    customObligationAddress?: PublicKey,
    hostAta?: PublicKey,
    customObligationSeed?: string,
    lookupTableAddress?: PublicKey,
    tipAmount?: number,
    repayReserve?: ReserveType,
    token2022Mint?: string
  ) {
    const seed = customObligationSeed ?? pool.address.slice(0, 32);
    const programId = getProgramId(environment);

    const obligationAddress =
      customObligationAddress ??
      (await PublicKey.createWithSeed(wallet.publicKey, seed, programId));

    const obligationAccountInfo = await connection.getAccountInfo(
      obligationAddress,
      "processed"
    );

    let obligationDetails = null;
    const depositReserves: Array<PublicKey> = [];
    const borrowReserves: Array<PublicKey> = [];

    if (obligationAccountInfo) {
      obligationDetails = parseObligation(
        PublicKey.default,
        obligationAccountInfo
      )!.info;

      obligationDetails.deposits.forEach((deposit) => {
        depositReserves.push(deposit.depositReserve);
      });

      obligationDetails.borrows.forEach((borrow) => {
        borrowReserves.push(borrow.borrowReserve);
      });
    }

    // Union of addresses
    const distinctReserveCount =
      Array.from(
        new Set([
          ...borrowReserves.map((e) => e.toBase58()),
          ...(action === "borrow" ? [reserve.address] : []),
        ])
      ).length +
      Array.from(
        new Set([
          ...depositReserves.map((e) => e.toBase58()),
          ...(action === "deposit" ? [reserve.address] : []),
        ])
      ).length;

    if (distinctReserveCount > POSITION_LIMIT) {
      throw Error(
        `Obligation already has max number of positions: ${POSITION_LIMIT}`
      );
    }

    const userTokenAccountAddress = await getAssociatedTokenAddress(
      new PublicKey(reserve.mintAddress),
      wallet.publicKey,
      true
    );
    const userCollateralAccountAddress = await getAssociatedTokenAddress(
      new PublicKey(reserve.cTokenMint),
      wallet.publicKey,
      true
    );

    const lookupTableAccount = lookupTableAddress
      ? (await connection.getAddressLookupTable(lookupTableAddress)).value
      : undefined;

    const userRepayTokenAccountAddress = repayReserve
      ? await getAssociatedTokenAddress(
          new PublicKey(repayReserve.mintAddress),
          wallet.publicKey,
          true
        )
      : undefined;

    const userRepayCollateralAccountAddress = repayReserve
      ? await getAssociatedTokenAddress(
          new PublicKey(repayReserve.cTokenMint),
          wallet.publicKey,
          true
        )
      : undefined;

    return new SolendActionCore(
      programId,
      connection,
      reserve,
      pool,
      wallet,
      obligationAddress,
      obligationDetails,
      userTokenAccountAddress,
      userCollateralAccountAddress,
      seed,
      distinctReserveCount,
      amount,
      depositReserves,
      borrowReserves,
      hostAta,
      lookupTableAccount ?? undefined,
      tipAmount,
      userRepayTokenAccountAddress,
      userRepayCollateralAccountAddress,
      token2022Mint ? new PublicKey(token2022Mint) : undefined,
      token2022Mint
        ? getAssociatedTokenAddressSync(
            new PublicKey(token2022Mint),
            wallet.publicKey,
            true,
            TOKEN_2022_PROGRAM_ID
          )
        : undefined
    );
  }

  static async buildForgiveTxns(
    pool: PoolType,
    reserve: ReserveType,
    connection: Connection,
    amount: string,
    wallet: Wallet,
    obligationAddress: PublicKey,
    environment: EnvironmentType = "production",
    lookupTableAddress?: PublicKey
  ) {
    const axn = await SolendActionCore.initialize(
      pool,
      reserve,
      "deposit",
      new BN(amount),
      wallet,
      connection,
      environment,
      obligationAddress,
      undefined,
      undefined,
      lookupTableAddress
    );

    await axn.addSupportIxs("forgive");
    await axn.addForgiveIx();

    return axn;
  }

  static async buildDepositTxns(
    pool: PoolType,
    reserve: ReserveType,
    connection: Connection,
    amount: string,
    wallet: Wallet,
    environment: EnvironmentType = "production",
    obligationAddress?: PublicKey,
    obligationSeed?: string,
    lookupTableAddress?: PublicKey,
    token2022Mint?: string
  ) {
    const axn = await SolendActionCore.initialize(
      pool,
      reserve,
      "deposit",
      new BN(amount),
      wallet,
      connection,
      environment,
      obligationAddress,
      undefined,
      obligationSeed,
      lookupTableAddress,
      undefined,
      undefined,
      token2022Mint
    );

    await axn.addSupportIxs("deposit");
    await axn.addDepositIx();

    return axn;
  }

  static async buildBorrowTxns(
    pool: PoolType,
    reserve: ReserveType,
    connection: Connection,
    amount: string,
    wallet: Wallet,
    environment: EnvironmentType = "production",
    customObligationAddress?: PublicKey,
    hostAta?: PublicKey,
    lookupTableAddress?: PublicKey,
    tipAmount?: number,
    token2022Mint?: string
  ) {
    const axn = await SolendActionCore.initialize(
      pool,
      reserve,
      "borrow",
      new BN(amount),
      wallet,
      connection,
      environment,
      customObligationAddress,
      hostAta,
      undefined,
      lookupTableAddress,
      tipAmount,
      undefined,
      token2022Mint
    );

    await axn.addSupportIxs("borrow");
    await axn.addBorrowIx();

    return axn;
  }
  static async buildDepositReserveLiquidityTxns(
    pool: PoolType,
    reserve: ReserveType,
    connection: Connection,
    amount: string,
    wallet: Wallet,
    environment: EnvironmentType = "production",
    lookupTableAddress?: PublicKey,
    token2022Mint?: string
  ) {
    const axn = await SolendActionCore.initialize(
      pool,
      reserve,
      "mint",
      new BN(amount),
      wallet,
      connection,
      environment,
      undefined,
      undefined,
      undefined,
      lookupTableAddress,
      undefined,
      undefined,
      token2022Mint
    );
    await axn.addSupportIxs("mint");
    await axn.addDepositReserveLiquidityIx();
    return axn;
  }

  static async buildRedeemReserveCollateralTxns(
    pool: PoolType,
    reserve: ReserveType,
    connection: Connection,
    amount: string,
    wallet: Wallet,
    environment: EnvironmentType = "production",
    lookupTableAddress?: PublicKey,
    token2022Mint?: string
  ) {
    const axn = await SolendActionCore.initialize(
      pool,
      reserve,
      "redeem",
      new BN(amount),
      wallet,
      connection,
      environment,
      undefined,
      undefined,
      undefined,
      lookupTableAddress,
      undefined,
      undefined,
      token2022Mint
    );
    await axn.addSupportIxs("redeem");
    await axn.addRedeemReserveCollateralIx();
    return axn;
  }

  static async buildDepositObligationCollateralTxns(
    pool: PoolType,
    reserve: ReserveType,
    connection: Connection,
    amount: string,
    wallet: Wallet,
    environment: EnvironmentType = "production",
    lookupTableAddress?: PublicKey,
    customObligationAddress?: PublicKey
  ) {
    const axn = await SolendActionCore.initialize(
      pool,
      reserve,
      "depositCollateral",
      new BN(amount),
      wallet,
      connection,
      environment,
      customObligationAddress,
      undefined,
      undefined,
      lookupTableAddress
    );
    await axn.addSupportIxs("depositCollateral");
    await axn.addDepositObligationCollateralIx();
    return axn;
  }

  static async buildWithdrawCollateralTxns(
    pool: PoolType,
    reserve: ReserveType,
    connection: Connection,
    amount: string,
    wallet: Wallet,
    environment: EnvironmentType = "production",
    lookupTableAddress?: PublicKey,
    customObligationAddress?: PublicKey
  ) {
    const axn = await SolendActionCore.initialize(
      pool,
      reserve,
      "withdrawCollateral",
      new BN(amount),
      wallet,
      connection,
      environment,
      customObligationAddress,
      undefined,
      undefined,
      lookupTableAddress
    );

    await axn.addSupportIxs("withdrawCollateral");
    await axn.addWithdrawIx();

    return axn;
  }

  static async buildWithdrawTxns(
    pool: PoolType,
    reserve: ReserveType,
    connection: Connection,
    amount: string,
    wallet: Wallet,
    environment: EnvironmentType = "production",
    obligationAddress?: PublicKey,
    obligationSeed?: string,
    lookupTableAddress?: PublicKey,
    tipAmount?: number,
    token2022Mint?: string
  ) {
    const axn = await SolendActionCore.initialize(
      pool,
      reserve,
      "withdraw",
      new BN(amount),
      wallet,
      connection,
      environment,
      obligationAddress,
      undefined,
      obligationSeed,
      lookupTableAddress,
      tipAmount,
      undefined,
      token2022Mint
    );

    await axn.addSupportIxs("withdraw");
    await axn.addWithdrawIx();

    return axn;
  }

  static async buildRepayTxns(
    pool: PoolType,
    reserve: ReserveType,
    connection: Connection,
    amount: string,
    wallet: Wallet,
    environment: EnvironmentType = "production",
    customObligationAddress?: PublicKey,
    lookupTableAddress?: PublicKey,
    token2022Mint?: string
  ) {
    const axn = await SolendActionCore.initialize(
      pool,
      reserve,
      "repay",
      new BN(amount),
      wallet,
      connection,
      environment,
      customObligationAddress,
      undefined,
      undefined,
      lookupTableAddress,
      undefined,
      undefined,
      token2022Mint
    );

    await axn.addSupportIxs("repay");
    await axn.addRepayIx();

    return axn;
  }

  static async buildLiquidateTxns(
    pool: PoolType,
    repayReserve: ReserveType,
    withdrawReserve: ReserveType,
    connection: Connection,
    amount: string,
    wallet: Wallet,
    environment: EnvironmentType = "production",
    customObligationAddress?: PublicKey,
    lookupTableAddress?: PublicKey,
    tipAmount?: number,
    token2022Mint?: string
  ) {
    const axn = await SolendActionCore.initialize(
      pool,
      withdrawReserve,
      "liquidate",
      new BN(amount),
      wallet,
      connection,
      environment,
      customObligationAddress,
      undefined,
      undefined,
      lookupTableAddress,
      tipAmount,
      repayReserve,
      token2022Mint
    );

    await axn.addSupportIxs("liquidate");
    await axn.addLiquidateIx(repayReserve);

    return axn;
  }

  async getInstructions() {
    
  }


  configureTip(jitoTipAmount: number) {
    this.jitoTipAmount = jitoTipAmount;
  }

  addForgiveIx() {
    this.lendingIxs.push({
      signers: [],
      instruction: forgiveDebtInstruction(
        this.obligationAddress,
        new PublicKey(this.reserve.address),
        new PublicKey(this.pool.address),
        new PublicKey(this.pool.owner),
        this.amount,
        this.programId
      ),
  });
  }

  addDepositIx() {
    this.lendingIxs.push({
      signers: [],
      instruction: 
      this.amount.toString() === U64_MAX
        ? depositMaxReserveLiquidityAndObligationCollateralInstruction(
            this.userTokenAccountAddress,
            this.userCollateralAccountAddress,
            new PublicKey(this.reserve.address),
            new PublicKey(this.reserve.liquidityAddress),
            new PublicKey(this.reserve.cTokenMint),
            new PublicKey(this.pool.address),
            new PublicKey(this.pool.authorityAddress),
            new PublicKey(this.reserve.cTokenLiquidityAddress), // destinationCollateral
            this.obligationAddress, // obligation
            this.publicKey, // obligationOwner
            new PublicKey(this.reserve.pythOracle),
            new PublicKey(this.reserve.switchboardOracle),
            this.publicKey, // transferAuthority
            this.programId
          )
        : depositReserveLiquidityAndObligationCollateralInstruction(
            this.amount,
            this.userTokenAccountAddress,
            this.userCollateralAccountAddress,
            new PublicKey(this.reserve.address),
            new PublicKey(this.reserve.liquidityAddress),
            new PublicKey(this.reserve.cTokenMint),
            new PublicKey(this.pool.address),
            new PublicKey(this.pool.authorityAddress),
            new PublicKey(this.reserve.cTokenLiquidityAddress), // destinationCollateral
            this.obligationAddress, // obligation
            this.publicKey, // obligationOwner
            new PublicKey(this.reserve.pythOracle),
            new PublicKey(this.reserve.switchboardOracle),
            this.publicKey, // transferAuthority
            this.programId
          )
      });
  }

  addDepositReserveLiquidityIx() {
    this.lendingIxs.push({
      signers: [],
      instruction: 
      depositReserveLiquidityInstruction(
        this.amount,
        this.userTokenAccountAddress,
        this.userCollateralAccountAddress,
        new PublicKey(this.reserve.address),
        new PublicKey(this.reserve.liquidityAddress),
        new PublicKey(this.reserve.cTokenMint),
        new PublicKey(this.pool.address),
        new PublicKey(this.pool.authorityAddress),
        this.publicKey, // transferAuthority
        this.programId
      )
    });
  }

  addRedeemReserveCollateralIx() {
    this.lendingIxs.push({
      signers: [],
      instruction: 
      redeemReserveCollateralInstruction(
        this.amount,
        this.userCollateralAccountAddress,
        this.userTokenAccountAddress,
        new PublicKey(this.reserve.address),
        new PublicKey(this.reserve.cTokenMint),
        new PublicKey(this.reserve.liquidityAddress),
        new PublicKey(this.pool.address), // pool
        new PublicKey(this.pool.authorityAddress), // poolAuthority
        this.publicKey, // transferAuthority
        this.programId
      )
    });
  }

  async addWithdrawObligationCollateralIx() {
    this.lendingIxs.push({
      signers: [],
      instruction: 
      withdrawObligationCollateralInstruction(
        this.amount,
        new PublicKey(this.reserve.cTokenLiquidityAddress),
        this.userCollateralAccountAddress,
        new PublicKey(this.reserve.address),
        this.obligationAddress, // obligation
        new PublicKey(this.pool.address), // pool
        new PublicKey(this.pool.authorityAddress), // poolAuthority
        this.publicKey, // transferAuthority
        this.programId,
        this.depositReserves.map((reserve) => new PublicKey(reserve))
      )
    });
  }

  addDepositObligationCollateralIx() {
    this.lendingIxs.push({
      signers: [],
      instruction: 
      depositObligationCollateralInstruction(
        this.amount,
        this.userCollateralAccountAddress,
        new PublicKey(this.reserve.cTokenLiquidityAddress),
        new PublicKey(this.reserve.address),
        this.obligationAddress, // obligation
        new PublicKey(this.pool.address),
        this.publicKey, // obligationOwner
        this.publicKey, // transferAuthority
        this.programId
      )
    });
  }

  addBorrowIx() {
    this.lendingIxs.push({
      signers: [],
      instruction: 
      borrowObligationLiquidityInstruction(
        this.amount,
        new PublicKey(this.reserve.liquidityAddress),
        this.userTokenAccountAddress,
        new PublicKey(this.reserve.address),
        new PublicKey(this.reserve.liquidityFeeReceiverAddress),
        this.obligationAddress,
        new PublicKey(this.pool.address), // lendingMarket
        new PublicKey(this.pool.authorityAddress), // lendingMarketAuthority
        this.publicKey,
        this.programId,
        this.depositReserves.map((reserve) => new PublicKey(reserve)),
        this.hostAta
      )
    });
  }

  async addWithdrawIx() {
    this.lendingIxs.push({
      signers: [],
      instruction: 
      this.amount.eq(new BN(U64_MAX))
        ? withdrawObligationCollateralAndRedeemReserveLiquidity(
            new BN(U64_MAX),
            new PublicKey(this.reserve.cTokenLiquidityAddress),
            this.userCollateralAccountAddress,
            new PublicKey(this.reserve.address),
            this.obligationAddress,
            new PublicKey(this.pool.address),
            new PublicKey(this.pool.authorityAddress),
            this.userTokenAccountAddress, // destinationLiquidity
            new PublicKey(this.reserve.cTokenMint),
            new PublicKey(this.reserve.liquidityAddress),
            this.publicKey, // obligationOwner
            this.publicKey, // transferAuthority
            this.programId,
            this.depositReserves.map((reserve) => new PublicKey(reserve))
          )
        : withdrawExact(
            this.amount,
            new PublicKey(this.reserve.cTokenLiquidityAddress),
            this.userCollateralAccountAddress,
            new PublicKey(this.reserve.address),
            new PublicKey(this.userTokenAccountAddress),
            new PublicKey(this.reserve.cTokenMint),
            new PublicKey(this.reserve.liquidityAddress),
            new PublicKey(this.obligationAddress),
            new PublicKey(this.pool.address),
            new PublicKey(this.pool.authorityAddress),
            new PublicKey(this.publicKey),
            new PublicKey(this.publicKey),
            this.programId,
            this.depositReserves.map((reserve) => new PublicKey(reserve))
          )
        });
  }

  async addRepayIx() {
    this.lendingIxs.push({
      signers: [],
      instruction: 
      this.amount.toString() === U64_MAX
        ? repayMaxObligationLiquidityInstruction(
            this.userTokenAccountAddress,
            new PublicKey(this.reserve.liquidityAddress),
            new PublicKey(this.reserve.address),
            this.obligationAddress,
            new PublicKey(this.pool.address),
            this.publicKey,
            this.programId
          )
        : repayObligationLiquidityInstruction(
            this.amount,
            this.userTokenAccountAddress,
            new PublicKey(this.reserve.liquidityAddress),
            new PublicKey(this.reserve.address),
            this.obligationAddress,
            new PublicKey(this.pool.address),
            this.publicKey,
            this.programId
          )
      }
    );
  }

  async addLiquidateIx(repayReserve: ReserveType) {
    if (
      !this.userRepayCollateralAccountAddress ||
      !this.userRepayTokenAccountAddress
    ) {
      throw Error("Not correctly initialized with a withdraw reserve.");
    }
    this.lendingIxs.push({
      signers: [],
      instruction: 
      liquidateObligationAndRedeemReserveCollateral(
        this.amount,
        this.userRepayTokenAccountAddress,
        this.userCollateralAccountAddress,
        this.userTokenAccountAddress,
        new PublicKey(repayReserve.address),
        new PublicKey(repayReserve.liquidityAddress),
        new PublicKey(this.reserve.address),
        new PublicKey(this.reserve.cTokenMint),
        new PublicKey(this.reserve.cTokenLiquidityAddress),
        new PublicKey(this.reserve.liquidityAddress),
        new PublicKey(this.reserve.feeReceiverAddress),
        this.obligationAddress,
        new PublicKey(this.pool.address),
        new PublicKey(this.pool.authorityAddress),
        this.publicKey,
        this.programId
      )
    });
  }

  async addSupportIxs(action: ActionType) {
    const supports = ACTION_SUPPORT_REQUIREMENTS[action];

    for (const support of supports) {
      switch (support) {
        case "createObligation":
          await this.addObligationIxs();
          break;
        case "wrap":
          if (this.wrappedAta) {
            await this.addWrapIx();
          }
          break;
        case "unwrap":
          if (this.wrappedAta) {
            await this.addUnwrapIx();
          }
          break;
        case "refreshReserves":
          await this.addRefreshReservesIxs();
          break;
        case "refreshObligation":
          await this.addRefreshObligationIxs();
          break;
        case "cAta":
          await this.addCAtaIxs();
          break;
        case "ata":
          await this.addAtaIxs();
          break;
        case "wrapUnwrapLiquidate":
          if (this.wrappedAta) {
            await this.addWrapUnwrapLiquidateIxs();
          }
          break;
        case "wsol":
          await this.updateWSOLAccount(action);
          break;
      }
    }
  }

  private async addWrapIx() {
    if (!this.wrappedAta || !this.token2022Mint)
      throw new Error("Wrapped ATA not initialized");
    this.preIxs.push({

      signers: [],
      instruction: 
      createAssociatedTokenAccountIdempotentInstruction(
        this.publicKey,
        this.userTokenAccountAddress,
        this.publicKey,
        new PublicKey(this.reserve.mintAddress)
      )}
    );

    this.preIxs.push({

      signers: [],
      instruction: 
      await createDepositAndMintWrapperTokensInstruction(
        this.publicKey,
        this.wrappedAta,
        this.token2022Mint,
        this.amount
      )}
    );
  }

  private async addUnwrapIx() {
    if (!this.wrappedAta || !this.token2022Mint)
      throw new Error("Wrapped ATA not initialized");
    this.preIxs.push({
      signers: [],
      instruction: 
      createAssociatedTokenAccountIdempotentInstruction(
        this.publicKey,
        this.wrappedAta,
        this.publicKey,
        this.token2022Mint,
        TOKEN_2022_PROGRAM_ID
      )}
    );

    this.postIxs.push(
      {signers: [],
      instruction: await createWithdrawAndBurnWrapperTokensInstruction(
        this.publicKey,
        this.wrappedAta,
        this.token2022Mint,
        this.amount
      )}
    );
  }

  private async addWrapUnwrapLiquidateIxs() {}

  private async buildPullPriceTxns(oracleKeys: Array<string>) {
    const oracleAccounts = await this.connection.getMultipleAccountsInfo(
      oracleKeys.map((o) => new PublicKey(o)),
      "processed"
    );
    const priceServiceConnection = new PriceServiceConnection(
      "https://hermes.pyth.network"
    );
    const pythSolanaReceiver = new PythSolanaReceiver({
      connection: this.connection,
      wallet: this.wallet,
    });
    const transactionBuilder = pythSolanaReceiver.newTransactionBuilder({
      closeUpdateAccounts: true,
    });

    const provider = new AnchorProvider(this.connection, this.wallet, {});
    const idl = (await Program.fetchIdl(SB_ON_DEMAND_PID, provider))!;
    const sbod = new Program(idl, provider);

    const sbPulledOracles = oracleKeys.filter(
      (_o, index) =>
        oracleAccounts[index]?.owner.toBase58() === sbod.programId.toBase58()
    );

    if (sbPulledOracles.length) {
    const feedAccounts = await Promise.all(
      sbPulledOracles.map((oracleKey) => new PullFeed(sbod as any, oracleKey))
    );
    const loadedFeedAccounts = await Promise.all(
      feedAccounts.map((acc) => acc.loadData())
    );

    const numSignatures = Math.max(
      ...loadedFeedAccounts.map(
        (f) => f.minSampleSize + Math.ceil(f.minSampleSize / 3)
      ),
      1
    );

    const crossbar = new CrossbarClient("https://crossbar.save.finance/");

    const [ix, accountLookups] = await PullFeed.fetchUpdateManyIx(sbod, {
      feeds: sbPulledOracles.map((p) => new PublicKey(p)),
      numSignatures,
      crossbarClient: crossbar,
    });

    const lookupTables = (await loadLookupTables(feedAccounts)).concat(
      accountLookups
    );

    const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: 1_000_000,
    });
    const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
      units: 1_000_000,
    });

    const instructions = [priorityFeeIx, modifyComputeUnits, ix];

    // Get the latest context
    const {
      value: { blockhash },
    } = await this.connection.getLatestBlockhashAndContext();

    // Get Transaction Message
    const message = new TransactionMessage({
      payerKey: this.publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message(lookupTables);

    this.preIxs.push(...instructions.map(i => ({ signers: [], instruction: i })));
    }
    const pythPulledOracles = oracleAccounts.filter(
      (o) =>
        o?.owner.toBase58() === pythSolanaReceiver.receiver.programId.toBase58()
    );

    const shuffledPriceIds = (
      pythPulledOracles
        .map((pythOracleData, index) => {
          if (!pythOracleData) {
            throw new Error(`Could not find oracle data at index ${index}`);
          }
          const priceUpdate =
            pythSolanaReceiver.receiver.account.priceUpdateV2.coder.accounts.decode(
              "priceUpdateV2",
              pythOracleData.data
            );

          const needUpdate =
            Date.now() / 1000 -
              Number(priceUpdate.priceMessage.publishTime.toString()) >
            30;

          return needUpdate
            ? {
                key: Math.random(),
                priceFeedId: toHexString(priceUpdate.priceMessage.feedId),
              }
            : undefined;
        })
        .filter(Boolean) as Array<{
        key: number;
        priceFeedId: string;
      }>
    )
      .sort((a, b) => a.key - b.key)
      .map((x) => x.priceFeedId);

    if (shuffledPriceIds.length) {
      const priceFeedUpdateData = await priceServiceConnection.getLatestVaas(
        shuffledPriceIds
      );

      await transactionBuilder.addUpdatePriceFeed(
        priceFeedUpdateData,
        0 // shardId of 0
      );

      const transactionsWithSigners =
        await transactionBuilder.buildVersionedTransactions({
          tightComputeBudget: true,
          jitoTipLamports: sbPulledOracles.length
            ? undefined
            : this.jitoTipAmount,
        });

      for (const transaction of transactionsWithSigners) {
        const signers = transaction.signers;
        const tx = transaction.tx;
        if (signers) {
          tx.sign(signers);
        }
        this.pullPriceTxns.push(tx);
      }
    }
  }

  private async addRefreshReservesIxs() {
    // Union of addresses
    const reserveMap = this.pool.reserves.reduce((acc, reserve) => {
      acc[reserve.address] = reserve;
      return acc;
    }, {} as Record<string, ReserveType>);

    const allReserveAddresses = Array.from(
      new Set([
        ...this.depositReserves.map((e) => e.toBase58()),
        ...this.borrowReserves.map((e) => e.toBase58()),
        this.reserve.address,
      ])
    );

    await this.buildPullPriceTxns([
      ...allReserveAddresses.map((address) => reserveMap[address].pythOracle),
      ...allReserveAddresses.map(
        (address) => reserveMap[address].switchboardOracle
      ),
      ...allReserveAddresses.map(
        (address) => reserveMap[address].extraOracle ?? NULL_ORACLE.toBase58()
      ),
    ]);

    allReserveAddresses.forEach((reserveAddress) => {
      const reserveInfo = this.pool.reserves.find(
        (reserve) => reserve.address === reserveAddress
      );
      if (!reserveInfo) {
        throw new Error(`Could not find asset ${reserveAddress} in reserves`);
      }

      const refreshReserveIx = refreshReserveInstruction(
        new PublicKey(reserveAddress),
        this.programId,
        new PublicKey(reserveInfo.pythOracle),
        new PublicKey(reserveInfo.switchboardOracle),
        reserveInfo.extraOracle
          ? new PublicKey(reserveInfo.extraOracle)
          : undefined
      );
      this.setupIxs.push(refreshReserveIx);
    });
  }

  private async addRefreshObligationIxs() {
    const refreshObligationIx = refreshObligationInstruction(
      this.obligationAddress,
      this.depositReserves,
      this.borrowReserves,
      this.programId
    );
    this.setupIxs.push(refreshObligationIx);
  }

  private async addObligationIxs() {
    if (!this.obligationAccountInfo) {
      const obligationAccountInfoRentExempt =
        await this.connection.getMinimumBalanceForRentExemption(
          OBLIGATION_SIZE
        );

      this.setupIxs.push(
        SystemProgram.createAccountWithSeed({
          fromPubkey: this.publicKey,
          newAccountPubkey: this.obligationAddress,
          basePubkey: this.publicKey,
          seed: this.seed,
          lamports: obligationAccountInfoRentExempt,
          space: OBLIGATION_SIZE,
          programId: this.programId,
        })
      );
      const initObligationIx = initObligationInstruction(
        this.obligationAddress,
        new PublicKey(this.pool.address),
        this.publicKey,
        this.programId
      );
      this.setupIxs.push(initObligationIx);
    }
  }

  private async addAtaIxs() {
    if (this.reserve.mintAddress !== NATIVE_MINT.toBase58()) {
      const userTokenAccountInfo = await this.connection.getAccountInfo(
        this.userTokenAccountAddress
      );
      if (!userTokenAccountInfo) {
        const createUserTokenAccountIx =
          createAssociatedTokenAccountInstruction(
            this.publicKey,
            this.userTokenAccountAddress,
            this.publicKey,
            new PublicKey(this.reserve.mintAddress)
          );

        if (
          this.positions === POSITION_LIMIT &&
          this.hostAta &&
          !this.lookupTableAccount
        ) {
          this.preIxs.push(createUserTokenAccountIx);
        } else {
          this.setupIxs.push(createUserTokenAccountIx);
        }
      }
    }
  }

  private async addCAtaIxs() {
    const userCollateralAccountInfo = await this.connection.getAccountInfo(
      this.userCollateralAccountAddress
    );

    if (!userCollateralAccountInfo) {
      const createUserCollateralAccountIx =
        createAssociatedTokenAccountInstruction(
          this.publicKey,
          this.userCollateralAccountAddress,
          this.publicKey,
          new PublicKey(this.reserve.cTokenMint)
        );

      if (
        this.positions === POSITION_LIMIT &&
        this.hostAta &&
        !this.lookupTableAccount
      ) {
        this.preIxs.push(createUserCollateralAccountIx);
      } else {
        this.setupIxs.push(createUserCollateralAccountIx);
      }
    }
  }

  private async updateWSOLAccount(action: ActionType) {
    if (this.reserve.mintAddress !== NATIVE_MINT.toBase58()) return;

    const preIxs: Array<TransactionInstruction> = [];
    const postIxs: Array<TransactionInstruction> = [];

    let safeRepay = new BN(this.amount);

    if (
      this.obligationAccountInfo &&
      action === "repay" &&
      this.amount.eq(new BN(U64_MAX))
    ) {
      const buffer = await this.connection.getAccountInfo(
        new PublicKey(this.reserve.address),
        "processed"
      );

      if (!buffer) {
        throw Error(`Unable to fetch reserve data for ${this.reserve.address}`);
      }

      const parsedData = parseReserve(
        new PublicKey(this.reserve.address),
        buffer
      )?.info;

      if (!parsedData) {
        throw Error(`Unable to parse data of reserve ${this.reserve.address}`);
      }

      const borrow = this.obligationAccountInfo.borrows.find(
        (borrow) => borrow.borrowReserve.toBase58() === this.reserve.address
      );

      if (!borrow) {
        throw Error(
          `Unable to find obligation borrow to repay for ${this.obligationAccountInfo.owner.toBase58()}`
        );
      }

      safeRepay = new BN(
        Math.floor(
          new BigNumber(borrow.borrowedAmountWads.toString())
            .multipliedBy(
              parsedData.liquidity.cumulativeBorrowRateWads.toString()
            )
            .dividedBy(borrow.cumulativeBorrowRateWads.toString())
            .dividedBy(WAD)
            .plus(SOL_PADDING_FOR_INTEREST)
            .toNumber()
        ).toString()
      );
    }

    const userWSOLAccountInfo = await this.connection.getAccountInfo(
      this.userTokenAccountAddress
    );

    const rentExempt = await getMinimumBalanceForRentExemptAccount(
      this.connection
    );

    const sendAction =
      action === "deposit" || action === "repay" || action === "mint";
    const transferLamportsIx = SystemProgram.transfer({
      fromPubkey: this.publicKey,
      toPubkey: this.userTokenAccountAddress,
      lamports:
        (userWSOLAccountInfo ? 0 : rentExempt) +
        (sendAction ? parseInt(safeRepay.toString(), 10) : 0),
    });
    preIxs.push(transferLamportsIx);

    const closeWSOLAccountIx = createCloseAccountInstruction(
      this.userTokenAccountAddress,
      this.publicKey,
      this.publicKey,
      []
    );

    if (userWSOLAccountInfo) {
      const syncIx = syncNative(this.userTokenAccountAddress);
      if (sendAction) {
        preIxs.push(syncIx);
      } else {
        postIxs.push(closeWSOLAccountIx);
      }
    } else {
      const createUserWSOLAccountIx = createAssociatedTokenAccountInstruction(
        this.publicKey,
        this.userTokenAccountAddress,
        this.publicKey,
        NATIVE_MINT
      );
      preIxs.push(createUserWSOLAccountIx);
      postIxs.push(closeWSOLAccountIx);
    }

    if (
      this.positions === POSITION_LIMIT &&
      this.hostAta &&
      !this.lookupTableAccount
    ) {
      this.preIxs.push(...preIxs);
      this.postTxnIxs.push(...postIxs);
    } else {
      this.setupIxs.push(...preIxs);
      this.cleanupIxs.push(...postIxs);
    }
  }
}
