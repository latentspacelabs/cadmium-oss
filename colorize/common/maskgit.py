from typing import *
import math

import torch


def get_scheduler(
    num_ids: int,
    num_steps: int,
    mode: str = "arccos"
) -> List[int]:
    num_steps = min(num_ids, num_steps)

    sche = torch.logspace(0.1, 1, num_steps, base=10.0) - 1
    sche = sche / sche.sum() * num_ids
    sche = torch.round(torch.flip(sche, [0]))

    sche[sche == 0] = 1

    # tokens to sample per timestep must not exceed the number of ids
    current_sum = 0
    truncated_sche = []
    for i in range(len(sche)):
        tokens_to_sample = sche[i].item()
        if (current_sum + tokens_to_sample) > num_ids:
            truncated_sche.append(int(num_ids - current_sum))
            break
        else:
            truncated_sche.append(int(tokens_to_sample))
            current_sum += tokens_to_sample

        if current_sum == num_ids:
            break

    return truncated_sche
