from datetime import date, timedelta
import math

PAY_PERIOD_ANCHOR = date(2026, 2, 2)
PAY_PERIOD_LEN = 14

def pay_period_for(d: date, anchor: date = PAY_PERIOD_ANCHOR, length_days: int = PAY_PERIOD_LEN):
    delta = (d - anchor).days
    n = math.floor(delta / length_days)
    start = anchor + timedelta(days=n * length_days)
    end = start + timedelta(days=length_days - 1)
    return start, end
