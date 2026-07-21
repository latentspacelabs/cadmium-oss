from typing import *
import os
import argparse

from colorize.datasets.file_readers import AnimerunFileReader


if __name__ == '__main__':
    argparser = argparse.ArgumentParser()
    argparser.add_argument('--data_path', type=str)
    argparser.add_argument('--glob_pattern', type=str)
    args = argparser.parse_args()

    path = os.path.join(args.data_path, "line_binary", args.glob_pattern)
    filereader = AnimerunFileReader(path)

    basename = os.path.basename(args.data_path)
    safe_glob = args.glob_pattern.replace('*', '')

    filereader.run(
        output_path=f'./datasets/{basename}-{safe_glob}',
    )
