import os
from typing import Optional
from pytorch_lightning.cli import LightningCLI
from pytorch_lightning.loggers import CometLogger
from pytorch_lightning.callbacks import ModelCheckpoint, EarlyStopping, LearningRateMonitor

from gap_closer import GapCloser
from datamodule import GapLineDataModule


def create_comet_logger(
    api_key: Optional[str] = None,
    project_name: str = "gap-closing-udf",
    experiment_name: Optional[str] = None,
    workspace: Optional[str] = None,
    offline: bool = False
) -> CometLogger:
    """Create Comet ML logger."""
    try:
        # COMET_API_KEY comes from the environment / .env (see root README);
        # never hardcode it here.
        os.environ["COMET_LOG_ASSETS"] = "True"
        os.environ["COMET_LOG_METRICS"] = "True"
        os.environ["COMET_LOG_HYPERPARAMETERS"] = "True"
        os.environ["COMET_MODE"] = "ONLINE"

        api_key = os.getenv('COMET_API_KEY')
        
        comet_logger = CometLogger(
            api_key=api_key,
            project_name=project_name,
            experiment_name=experiment_name,
            workspace=workspace,
            offline=False,
            save_dir="logs/comet"
        )
        
        print(f"Comet logger created: {'offline' if offline else 'online'} mode")
        return comet_logger
        
    except Exception as e:
        print(f"Failed to create Comet logger: {e}")
        print("No fallback logger available - Comet required")
        raise e


def create_callbacks(
    save_dir: str = "logs/lightning",
    checkpoint_filename: str = "model-{epoch:02d}-{val/total_loss:.4f}",
    patience: int = 20,
) -> list:
    """Create training callbacks with architecture-specific settings."""
    
    # Model checkpoint callback
    checkpoint_callback = ModelCheckpoint(
        dirpath=save_dir,
        filename=checkpoint_filename,
        monitor="val/total_loss",
        mode="min",
        save_top_k=3,
        save_last=True,
        verbose=True
    )
    
    # Early stopping callback
    early_stop_callback = EarlyStopping(
        monitor="val/total_loss",
        patience=patience,
        mode="min",
        verbose=True
    )
    
    # Learning rate monitor
    lr_monitor = LearningRateMonitor(logging_interval='epoch')
    
    return [checkpoint_callback, early_stop_callback, lr_monitor]


class UnifiedGapClosingCLI(LightningCLI):
    """Unified Lightning CLI for all gap closing architectures."""
    
    def add_arguments_to_parser(self, parser):
        parser.add_argument("--log_dir", default="logs/lightning", help="Log directory")
        parser.add_argument("--auto_detect", default=True, help="Auto-detect settings from config")

    def before_fit(self):
        self.trainer.logger = create_comet_logger()

        log_dir = "logs/lightning"
        callbacks = create_callbacks(
            save_dir=log_dir,
            checkpoint_filename='epoch-{{epoch:02d}}-{{val/total_loss:.4f}}',
            patience=20
        )
        
        for callback in callbacks:
            if not any(isinstance(cb, type(callback)) for cb in self.trainer.callbacks):
                self.trainer.callbacks.append(callback)
        
        if hasattr(self.model, 'model'):
            total_params = sum(p.numel() for p in self.model.parameters())
            print(f"Parameters: {total_params:,}")


def main():
    """Main training function with unified CLI."""
    
    cli = UnifiedGapClosingCLI(
        GapCloser,
        GapLineDataModule,
        seed_everything_default=42,
        save_config_kwargs={"overwrite": True},  # Allow config overwriting
    )


if __name__ == "__main__":
    main()
