import { Account, Connection, PublicKey } from "@solana/web3.js";
import { parseObligation } from "@solendprotocol/solend-sdk";
import bs58 from "bs58";
import dotenv from "dotenv";
import { liquidateAndRedeem } from "libs/actions/liquidateAndRedeem";
import { getTokensOracleData } from "libs/oracle";
import { Borrow, calculateRefreshedObligation } from "libs/refreshObligation";
import { readSecret } from "libs/secret";
import {
  getObligations,
  getReserves,
  getWalletTokenData,
  sortBorrows,
  wait,
} from "libs/utils";
import { getMarkets } from "./config";

dotenv.config();

async function runLiquidator() {
  const rpcEndpoint = process.env.RPC_ENDPOINT;
  if (!rpcEndpoint) {
    throw new Error(
      "Pls provide an private RPC endpoint in docker-compose.yaml"
    );
  }
  const markets = await getMarkets();
  const connection = new Connection(rpcEndpoint, "confirmed");
  // liquidator's keypair.
  const secret = readSecret("keypair");

  const bs = bs58.decode(secret);

  const payer = new Account(bs);

  console.log(`
    app: ${process.env.APP}
    rpc: ${rpcEndpoint}
    
    Running against ${markets.length} pools
  `);

  for (let epoch = 0; ; epoch += 1) {
    for (const market of markets) {
      const tokensOracle = await getTokensOracleData(connection, market);
      const allObligations = await getObligations(connection, market.address);
      const allReserves = await getReserves(connection, market.address);

      for (let obligation of allObligations) {
        try {
          while (obligation) {
            const { borrowedValue, unhealthyBorrowValue, deposits, borrows } =
              calculateRefreshedObligation(
                obligation.info,
                allReserves,
                tokensOracle
              );

            // Do nothing if obligation is healthy
            if (borrowedValue.isLessThanOrEqualTo(unhealthyBorrowValue)) {
              break;
            }

            // select repay token that has the highest market value
            const selectedBorrow: Borrow | undefined = sortBorrows(borrows)[0];

            // select the withdrawal collateral token with the highest market value
            let selectedDeposit;
            deposits.forEach((deposit) => {
              if (
                !selectedDeposit ||
                deposit.marketValue.gt(selectedDeposit.marketValue)
              ) {
                selectedDeposit = deposit;
              }
            });

            if (!selectedBorrow || !selectedDeposit) {
              // skip toxic obligations caused by toxic oracle data
              break;
            }

            console.log(`Obligation ${obligation.pubkey.toString()} is underwater
              borrowedValue: ${borrowedValue.toString()}
              unhealthyBorrowValue: ${unhealthyBorrowValue.toString()}
              market address: ${market.address}`);

            // get wallet balance for selected borrow token
            const { balanceBase } = await getWalletTokenData(
              connection,
              market,
              payer,
              selectedBorrow.mintAddress,
              selectedBorrow.symbol
            );
            if (balanceBase === 0) {
              console.log(
                `insufficient ${
                  selectedBorrow.symbol
                } to liquidate obligation ${obligation.pubkey.toString()} in market: ${
                  market.address
                }`
              );
              break;
            } else if (balanceBase < 0) {
              console.log(`failed to get wallet balance for ${
                selectedBorrow.symbol
              } to liquidate obligation ${obligation.pubkey.toString()} in market: ${
                market.address
              }. 
                Potentially network error or token account does not exist in wallet`);
              break;
            }

            // Set super high liquidation amount which acts as u64::MAX as program will only liquidate max
            // 50% val of all borrowed assets.
            await liquidateAndRedeem(
              connection,
              payer,
              balanceBase,
              selectedBorrow.symbol,
              selectedDeposit.symbol,
              market,
              obligation
            );

            const postLiquidationObligation = await connection.getAccountInfo(
              new PublicKey(obligation.pubkey)
            );
            obligation = parseObligation(
              obligation.pubkey,
              postLiquidationObligation!
            );
          }
        } catch (err) {
          console.error(
            `error liquidating ${obligation!.pubkey.toString()}: `,
            err
          );
          continue;
        }
      }

      // Throttle to avoid rate limiter
      if (process.env.THROTTLE) {
        await wait(Number(process.env.THROTTLE));
      }
    }
  }
}

runLiquidator();
