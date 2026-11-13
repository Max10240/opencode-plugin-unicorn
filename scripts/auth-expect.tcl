set timeout 3600
fconfigure stdout -buffering line
fconfigure stderr -buffering line
log_user 1
set command {}
set count 0
if {[info exists env(AUTH_ARGC)]} {
  set count $env(AUTH_ARGC)
}
for {set i 0} {$i < $count} {incr i} {
  lappend command $env(AUTH_ARG_$i)
}
if {[llength $command] == 0} {
  puts "__AUTH_EXIT__ 2"
  exit 2
}
spawn {*}$command
expect {
  -re {Press ENTER[^\r\n]*} { send "\r"; exp_continue }
  eof
}
catch wait result
puts "\n__AUTH_EXIT__ [lindex $result 3]"
