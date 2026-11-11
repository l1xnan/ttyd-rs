mod cli;
mod config;
mod cwd;
mod html;
mod pty;
mod server;
mod session;
mod tls;
mod transfer;
mod ws;

use cli::Action;

#[tokio::main]
async fn main() {
    let action = match cli::parse_args() {
        Ok(action) => action,
        Err(error) => {
            eprintln!("ttyd: {error}");
            std::process::exit(1);
        }
    };

    match action {
        Action::Help => cli::print_help(),
        Action::Version => cli::print_version(),
        Action::Run(config) => {
            if let Err(error) = cli::check_cwd(&config.cwd) {
                eprintln!("ttyd: {error}");
                std::process::exit(1);
            }
            if let Err(error) = server::run(*config).await {
                eprintln!("ttyd: {error:#}");
                std::process::exit(1);
            }
        }
    }
}
