# zedcode-shell-integration (zprofile)
#
# See zshenv.zsh for the rationale on the trailing `:`.
{
  _zedcode_user_zdotdir="${ZEDCODE_USER_ZDOTDIR:-$HOME}"
  [ -f "$_zedcode_user_zdotdir/.zprofile" ] && source "$_zedcode_user_zdotdir/.zprofile"
  unset _zedcode_user_zdotdir
}
:
