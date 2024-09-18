import { Connection, PublicKey } from "@solana/web3.js";
import SwitchboardProgram from "@switchboard-xyz/sbv2-lite";
import { AggregatorState } from "@switchboard-xyz/switchboard-api";
import BigNumber from "bignumber.js";
import { MarketConfig, MarketConfigReserve } from "global";

const NULL_ORACLE = "nu11111111111111111111111111111111111111111";
const SWITCHBOARD_V1_ADDRESS = "DtmE9D2CSB4L5D6A15mraeEjrGMm6auWVzgaD8hK2tZM";
const SWITCHBOARD_V2_ADDRESS = "SW1TCH7qEPTdLsDHRgPuMQjbQxKdH2aBStViMFnt64f";

let switchboardV2: SwitchboardProgram | undefined;

export type TokenOracleData = {
  symbol: string;
  reserveAddress: string;
  mintAddress: string;
  decimals: BigNumber;
  price: BigNumber;
};

async function getTokenOracleData(
  connection: Connection,
  reserve: MarketConfigReserve
) {
  let priceData;
  const oracle = {
    switchboardFeedAddress: reserve.switchboardOracle,
  };

  const pricePublicKey = new PublicKey(oracle.switchboardFeedAddress);
  const info = await connection.getAccountInfo(pricePublicKey);
  const owner = info?.owner.toString();
  if (owner === SWITCHBOARD_V1_ADDRESS) {
    const result = AggregatorState.decodeDelimited(
      (info?.data as Buffer)?.slice(1)
    );
    priceData = result?.lastRoundResult?.result;
  } else if (owner === SWITCHBOARD_V2_ADDRESS) {
    if (!switchboardV2) {
      switchboardV2 = await SwitchboardProgram.loadMainnet(connection);
    }
    const result = switchboardV2.decodeLatestAggregatorValue(info!);
    priceData = result?.toNumber();
  } else {
    console.error("unrecognized switchboard owner address: ", owner);
  }

  if (!priceData) {
    console.error(
      `failed to get price for ${reserve.liquidityToken.symbol} | reserve ${reserve.address}`
    );
    priceData = 0;
  }

  return {
    symbol: reserve.liquidityToken.symbol,
    reserveAddress: reserve.address,
    mintAddress: reserve.liquidityToken.mint,
    decimals: new BigNumber(10 ** reserve.liquidityToken.decimals),
    price: new BigNumber(priceData!),
  } as TokenOracleData;
}

export async function getTokensOracleData(
  connection: Connection,
  market: MarketConfig
) {
  const promises: Promise<any>[] = market.reserves.map((reserve) =>
    getTokenOracleData(connection, reserve)
  );
  return Promise.all(promises);
}
