
export function makePanic({ onTrigger }) {
  let armed = true;
  return {
    arm: ()=> armed = true,
    disarm: ()=> armed = false,
    ownerRiskTx: async (desc) => { if (armed) await onTrigger('owner-risk:'+desc); },
    lpDrop: async (pct) => { if (armed && pct>20) await onTrigger('lp-drop:'+pct) },
    priceCrash: async () => { if (armed) await onTrigger('price-crash') }
  };
}
