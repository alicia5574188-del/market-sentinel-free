import test from 'node:test';
import assert from 'node:assert/strict';
import {observationReading,observationTape,type ObservationTape} from '../lib/observation-tape.ts';
import type {MarketIntelligenceState} from '../lib/market-intelligence-engine.ts';

function state(over:Partial<MarketIntelligenceState>={}):MarketIntelligenceState{
  return {updatedAt:1_000,narrative:{macro:{score:.14},major:{score:-.17},short:{score:-.07},
    transition:{pressure:22,drivers:['广度恶化']}},
    internals:{breadth3:-.13,breadth12:-.08,breadthSlope:.04,dispersion:.74,synchrony:.63,
      bookImbalance:-.06,bidLiquidityChange:-.04,askLiquidityChange:.02,spreadRate:.00032,
      venuePressure:-.19,leaderPersistence:.7,residualBalance:0},
    liquidity:{market:{ready:true,migrationBreadth:-.12,acceptedShare:.08,rejectedShare:.18,insideShare:.6,
      testingShare:.1,upMigrationShare:.05,downMigrationShare:.2,oneSidedDepletionShare:.1}},
    ...over} as MarketIntelligenceState;
}
test('tape keeps the raw prints and does not order',()=>{
  const tape=observationTape(state());
  assert.equal(tape.breadth3,-.13);
  assert.equal(tape.spread,.00032);
  assert.equal(tape.migration,-.12);
  assert.deepEqual(tape.drivers,['广度恶化']);
  const prior={...tape,at:0,breadth3:.05} as ObservationTape;
  const reading=observationReading(state(),[prior]);
  assert.equal(reading.ordersAffected,false);
  assert.match(reading.sentence,/3根广度下降/);
  assert.match(reading.lines[0],/近3根 -13/);
  assert.match(reading.lines[1],/价差 3.2bp/);
});
