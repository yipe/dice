# Sums the joke formula (web/formula.ts) over every miss/hit/crit path and save result, with exact fractions.
from fractions import Fraction as F
from itertools import product
pi0={'m':F(7,20),'h':F(12,20),'c':F(1,20)}
pc=1-F(19,20)**2; pm=F(7,20)**2
pi1={'m':pm,'h':1-pm-pc,'c':pc}
def mu(i,o):
    if o=='m': return 0
    base=F(9,2) if o=='h' else F(9)
    return base+(4 if i!=5 else 0)
tot=F(0)
for o in product('mhc',repeat=5):
    o=dict(zip(range(1,6),o))
    k=next((j for j in (1,2) if o[j]!='m'),None)
    for s,ps in (('f',F(1,2)),('p',F(1,2))):
        p=ps
        for i in range(1,6):
            a=(k is not None and k<i and (s=='f' or i==k+1)) or (i in (4,5) and o[i-1]!='m')
            p*=(pi1 if a else pi0)[o[i]]
        js=next((j for j in (3,4,5) if o[j]!='m'),None)
        d=sum(mu(i,o[i]) for i in range(1,6))+(F(7,2)*(2 if o[js]=='c' else 1) if js else 0)
        tot+=p*d
print(tot, float(tot))

assert tot == F(90546632123, 2560000000), tot  # DPR_EXACT in src/stunData.ts
