import argparse
import csv
import glob
import os
import pickle

import numpy as np
from tqdm import tqdm

from colorize.datasets.constants import VEC_FIELD_NAMES
from colorize.vectorization.lib.svg import SVG
from colorize.common.sequence import Sequence
from colorize.common.image import ImageArgs
from colorize.vectorization.vtrace import VecArgs
from colorize.ant_v1.tokenizer_ant_v1 import AnTV1Tokenizer


vec_args = VecArgs()

image_args = ImageArgs()
    
tokenizer = AnTV1Tokenizer(
    image_args=image_args,
    vec_args=vec_args,
    max_segments=512,
    max_vec_seq_length=1024,
)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--cleaned_dataset_path', type=str)
    args = parser.parse_args()

    sequence_paths = glob.glob(os.path.join(args.cleaned_dataset_path, 'sequences/*.pkl'))

    stats_path = os.path.join(args.cleaned_dataset_path, 'vectorization_stats.csv')

    with open(stats_path, 'w', newline='') as csvfile:
        csv_writer = csv.DictWriter(csvfile, fieldnames=VEC_FIELD_NAMES)
        csv_writer.writeheader()

        for sequence_path in tqdm(sequence_paths):
            seq: Sequence = pickle.load(open(sequence_path, 'rb'))

            seq.materialize(color_source='color_list')

            seq.prepare_images_for_training(
                augment=True,
                image_args=tokenizer.image_args,
                vec_args=tokenizer.vec_args,
            )

            for frame in seq.frames:
                svg = frame.seg_frame.svg

                seg_path_counts = []
                for path in svg.paths:
                    seg_path_counts.append(len(path.path_commands))

                min_seg_path_count = min(seg_path_counts)
                max_seg_path_count = max(seg_path_counts)
                mean_seg_path_count = np.mean(seg_path_counts)
                median_seg_path_count = np.median(seg_path_counts)
                std_seg_path_count = np.std(seg_path_counts)

                csv_writer.writerow({
                    'sequence_path': sequence_path,
                    'seg_path': frame.seg_frame.path,
                    'num_segs': len(svg.paths),
                    'seg_path_counts_min': min_seg_path_count,
                    'seg_path_counts_max': max_seg_path_count,
                    'seg_path_counts_mean': mean_seg_path_count,
                    'seg_path_counts_median': median_seg_path_count,
                    'seg_path_counts_std': std_seg_path_count,
                })
                # print(f'SVG: {svg.to_str()}')
                # print(f'Num segments: {len(svg.paths)}')
                # print(f'Num points: {len(svg.paths[0].path_commands)}')
