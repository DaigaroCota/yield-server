const sdk = require('@defillama/sdk');
const axios = require('axios');
const abiLendingPool = require('./abiLendingPool');
const abiProtocolDataProvider = require('./abiProtocolDataProvider');
const abiChefIncentivesController = require('./abiChefIncentivesController');

const utils = require('../utils');

const RDNT = '0x0c4681e6c0235179ec3d4f4fc4df3d14fdd96017';

// note: disabled rewards completely as they require locking of dLP tokens
// https://docs.radiant.capital/radiant/project-info/dlp/dlp-utility
// const earlyExitPenalty = 1 - 0.9;

const chains = {
  arbitrum: {
    LendingPool: '0xF4B1486DD74D07706052A33d31d7c0AAFD0659E1',
    ProtocolDataProvider: '0x596B0cc4c5094507C50b579a662FE7e7b094A2cC',
    ChefIncentivesController: '0xebC85d44cefb1293707b11f707bd3CEc34B4D5fA',
    url: '0x091d52CacE1edc5527C99cDCFA6937C1635330E4',
  },
  bsc: {
    LendingPool: '0xd50Cf00b6e600Dd036Ba8eF475677d816d6c4281',
    ProtocolDataProvider: '0x2f9D57E97C3DFED8676e605BC504a48E0c5917E9',
    ChefIncentivesController: '0x7C16aBb090d3FB266E9d17F60174B632f4229933',
    url: '0x63764769dA006395515c3f8afF9c91A809eF6607',
  },
  ethereum: {
    LendingPool: '0xA950974f64aA33f27F6C5e017eEE93BF7588ED07',
    ProtocolDataProvider: '0x362f3BB63Cff83bd169aE1793979E9e537993813',
    ChefIncentivesController: '0x14b0A611230Dc48E9cc048d3Ae5279847Bf30919',
    url: '0x70e507f1d20AeC229F435cd1EcaC6A7200119B9F',
  },
};

const getApy = async () => {
  const pools = await Promise.all(
    Object.keys(chains).map(async (chain) => {
      const addresses = chains[chain];

      const reservesList = (
        await sdk.api.abi.call({
          target: addresses.LendingPool,
          abi: abiLendingPool.find((m) => m.name === 'getReservesList'),
          chain,
        })
      ).output;

      const reserveData = (
        await sdk.api.abi.multiCall({
          calls: reservesList.map((i) => ({
            target: addresses.LendingPool,
            params: [i],
          })),
          abi: abiLendingPool.find((m) => m.name === 'getReserveData'),
          chain,
        })
      ).output.map((o) => o.output);

      const [liquidityRes, decimalsRes, symbolsRes] = await Promise.all(
        ['erc20:balanceOf', 'erc20:decimals', 'erc20:symbol'].map((method) =>
          sdk.api.abi.multiCall({
            abi: method,
            calls: reservesList.map((t, i) => ({
              target: t,
              params:
                method === 'erc20:balanceOf'
                  ? reserveData[i].aTokenAddress
                  : null,
            })),
            chain,
          })
        )
      );

      const liquidity = liquidityRes.output.map((o) => o.output);
      const decimals = decimalsRes.output.map((o) => o.output);
      const symbols = symbolsRes.output.map((o) => o.output);

      const totalBorrow = (
        await sdk.api.abi.multiCall({
          abi: 'erc20:totalSupply',
          calls: reserveData.map((p) => ({
            target: p.variableDebtTokenAddress,
          })),
          chain,
        })
      ).output.map((o) => o.output);

      const reserveConfigurationData = (
        await sdk.api.abi.multiCall({
          calls: reservesList.map((t) => ({
            target: addresses.ProtocolDataProvider,
            params: t,
          })),
          chain,
          abi: abiProtocolDataProvider.find(
            (n) => n.name === 'getReserveConfigurationData'
          ),
        })
      ).output.map((o) => o.output);

      const rewardsPerSecond = (
        await sdk.api.abi.call({
          chain,
          target: addresses.ChefIncentivesController,
          abi: abiChefIncentivesController.find(
            (m) => m.name === 'rewardsPerSecond'
          )
        })
      ).output;

      const totalAllocPoint = (
        await sdk.api.abi.call({
          chain,
          target: addresses.ChefIncentivesController,
          abi: abiChefIncentivesController.find(
            (n) => n.name === 'totalAllocPoint'
          )
        })
      ).output;

      const poolInfoInterest = (
        await sdk.api.abi.multiCall({
          abi: abiChefIncentivesController.find((n) => n.name === 'poolInfo'),
          calls: reserveData.map((t, i) => ({
            target: addresses.ChefIncentivesController,
            params: reserveData[i].aTokenAddress,
          })),
          chain,
        })
      ).output.map((o) => o.output);

      const poolInfoDebt = (
        await sdk.api.abi.multiCall({
          abi: abiChefIncentivesController.find((n) => n.name === 'poolInfo'),
          calls: reserveData.map((t, i) => ({
            target: addresses.ChefIncentivesController,
            params: reserveData[i].variableDebtTokenAddress,
          })),
          chain,
        })
      ).output.map((o) => o.output);
      // console.log('chain:', chain, 'rewardsPerSecond', rewardsPerSecond, 'totalAllocPoint', totalAllocPoint);

      // Reference price of RDNT on Arbitrum since its where it is the most liquid.
      const pricesArray = reservesList.map((t) => `${chain}:${t}`).concat(`arbitrum:${RDNT}`);

      const prices = (
        await axios.get(`https://coins.llama.fi/prices/current/${pricesArray}`)
      ).data.coins;

      const rewardPerYear =
        (rewardsPerSecond / 1e18) *
        86400 *
        365 *
        prices[`arbitrum:${RDNT}`]?.price;
      
      // console.log('rewardPerYear', rewardPerYear);

      return reservesList.map((t, i) => {
        const config = reserveConfigurationData[i];
        if (!config.isActive) return null;

        const price = prices[`${chain}:${t}`]?.price;

        const tvlUsd = (liquidity[i] / 10 ** decimals[i]) * price;
        const totalBorrowUsd = (totalBorrow[i] / 10 ** decimals[i]) * price;
        // TODO
        // const eligibleTotalBorrowUsd = 
        const totalSupplyUsd = tvlUsd + totalBorrowUsd;
        // TODO
        // const eligibleSupplyUsd = 

        const apyBase = reserveData[i].currentLiquidityRate / 1e25;
        const apyBaseBorrow = reserveData[i].currentVariableBorrowRate / 1e25;

        // TODO replace with `eligibleSupplyUsd`
        const apyReward =
          (((poolInfoInterest[i].allocPoint / totalAllocPoint) *
            rewardPerYear) /
            totalSupplyUsd) *
          100;

        // TODO replace with `eligibleBorrowUsd`
        const apyRewardBorrow =
          (((poolInfoDebt[i].allocPoint / totalAllocPoint) * rewardPerYear) /
            totalBorrowUsd) *
          100;

        const ltv = config.ltv / 1e4;
        const borrowable = config.borrowingEnabled;
        const frozen = config.isFrozen;

        // url for pools
        const url =
          `https://app.radiant.capital/#/asset-detail/${t}-${t}${chains[chain].url}`.toLowerCase();

        https: return {
          pool: `${reserveData[i].aTokenAddress}-${chain}`.toLowerCase(),
          symbol: symbols[i],
          project: 'radiant-v2',
          chain,
          tvlUsd,
          apyBase,
          apyReward: apyReward,
          underlyingTokens: [t],
          // borrow fields
          totalSupplyUsd,
          totalBorrowUsd,
          apyBaseBorrow,
            apyRewardBorrow: apyRewardBorrow,
          rewardTokens: [RDNT],
          ltv,
          borrowable,
          poolMeta: frozen ? 'frozen' : null,
          url: `${url}-Borrow`,
        };
      });
    })
  );
  return pools.flat().filter((p) => utils.keepFinite(p));
};

module.exports = {
  apy: getApy,
};
