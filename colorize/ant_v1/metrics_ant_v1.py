from typing import *

import comet_ml
import torch
from sklearn.metrics import accuracy_score, precision_recall_fscore_support
from transformers import EvalPrediction


def preprocess_logits_for_metrics(logits, labels):
    # we are just taking the first element of the tuple, which is the argmax'd id predictions
    if isinstance(logits, tuple):
        logits = logits[0]
    return logits


def compute_metrics(eval_preds: EvalPrediction) -> Dict[str, torch.Tensor]:
    experiment = comet_ml.get_global_experiment()

    batch_acc = []
    batch_prec = []
    batch_rec = []
    batch_f1 = []

    preds, labels = eval_preds
    for pred_seq, label_seq in zip(preds, labels):
        assert len(label_seq) == len(pred_seq)
        active_seg_mask = (pred_seq != -100) & (label_seq != -100)
        label_seq = label_seq[active_seg_mask]
        pred_seq = pred_seq[active_seg_mask]
        assert len(label_seq) == len(pred_seq)

        if len(active_seg_mask) ==0:
            print("NO ACTIVE SEGMENTS")
            continue

        acc = accuracy_score(label_seq, pred_seq)
        precision, recall, f1, _ = precision_recall_fscore_support(
            label_seq, pred_seq, average="macro"
        )

        batch_acc.append(acc)
        batch_prec.append(precision)
        batch_rec.append(recall)
        batch_f1.append(f1)

    batch_acc = sum(batch_acc) / len(batch_acc)
    batch_prec = sum(batch_prec) / len(batch_prec)
    batch_rec = sum(batch_rec) / len(batch_rec)
    batch_f1 = sum(batch_f1) / len(batch_f1)

    if experiment:
        epoch = int(experiment.curr_epoch) if experiment.curr_epoch is not None else 0
        experiment.set_epoch(epoch)

    return {
        "accuracy": batch_acc,
        "f1": batch_f1,
        "precision": batch_prec,
        "recall": batch_rec
    }

